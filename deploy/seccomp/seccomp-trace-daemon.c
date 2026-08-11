/*
 * seccomp-trace-daemon.c
 * 守护进程：监听 unix socket，等待注入库（blink-server）READY 后 attach，
 * 用 PTRACE_O_TRACESECCOMP 跟踪，在 ioctl(KVM_GET_SUPPORTED_CPUID) 返回时
 * 通过 PTRACE_POKEDATA 修改 shim 的 CPUID 缓冲区（过滤新特性）。
 *
 * 编译: gcc -O2 -o seccomp-trace-daemon seccomp-trace-daemon.c
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/user.h>
#include <sys/stat.h>
#include <linux/kvm.h>
#include <linux/ptrace.h>
#include <stdint.h>
#include <stddef.h>

#define SOCK_PATH "/run/xensemble/seccomp-trace.sock"
#define KVM_GET_SUPPORTED_CPUID_IOCTL 0xC008AE05UL
#define MAX_CPUID_ENTRIES 128

static int should_remove(struct kvm_cpuid_entry2 *e) {
    unsigned int fn = e->function;
    unsigned int idx = e->index;
    /* Preserve hypervisor/kvm-clock leaves so the guest can sync time via kvm-clock */
    if (fn >= 0x40000000 && fn < 0x40000100) return 0;
    /* Remove AMX detection leaves (Sapphire Rapids+: 0x1E and above, below 0x80000000) */
    if (fn >= 0x1e && fn < 0x80000000) return 1;
    /* Remove AMX feature bits in leaf 7 sub-leaf 1 */
    if (fn == 0x07 && idx == 1) return 1;
    /* Remove AMX XSAVE state (0x11=TILECFG/TILEDATA, 0x09=PT) */
    if (fn == 0x0d && (idx == 0x9 || idx == 0x11)) return 1;
    return 0;
}

static void adjust_entry(struct kvm_cpuid_entry2 *e) {
    unsigned int fn = e->function;
    unsigned int idx = e->index;
    /* Limit max standard leaf to 0x0D (consistent with should_remove) */
    if (fn == 0x00) e->eax = 0x0000000d;
    /* Fake CPU model as Skylake-SP (non-AMX processor) */
    if (fn == 0x01) { e->eax = 0x00050657; e->ebx = 0x03040800; }
    /* Remove AMX bits from leaf 7 sub-leaf 0, keep AVX2/BMI2/etc */
    if (fn == 0x07 && idx == 0) {
        e->eax = 0x00000000; e->ebx = 0xd19f2ffb; e->ecx = 0x00000804; e->edx = 0xac000400;
    }
    /* Remove AMX XSAVE state from leaf 0x0D */
    if (fn == 0x0d && idx == 0) {
        e->eax = 0x000000e7; e->ebx = 0x00000a80; e->ecx = 0x00000a80;
    }
    if (fn == 0x0d && idx == 1) { e->eax = 0x0000000f; e->ebx = 0x00000980; }
    /* Match faked CPU model: L2 cache and address bits */
    if (fn == 0x80000006) e->ecx = 0x01006040;
    if (fn == 0x80000008) { e->eax = 0x0000302e; e->ebx = 0x0100d000; }
}

static long peek_word(pid_t pid, unsigned long addr) {
    errno = 0;
    return ptrace(PTRACE_PEEKDATA, pid, (void *)addr, 0);
}

static void poke_word(pid_t pid, unsigned long addr, long val) {
    ptrace(PTRACE_POKEDATA, pid, (void *)addr, (void *)val);
}

static void modify_cpuid_buffer(pid_t pid, unsigned long buf) {
    struct kvm_cpuid_entry2 entries[MAX_CPUID_ENTRIES];
    uint32_t nent;
    unsigned int i, write;

    long word0 = peek_word(pid, buf);
    if (word0 == -1 && errno) { fprintf(stderr, "[D] peek nent fail %s\n", strerror(errno)); return; }
    nent = (uint32_t)(word0 & 0xffffffff);
    if (nent == 0 || nent > MAX_CPUID_ENTRIES) { fprintf(stderr, "[D] bad nent=%u\n", nent); return; }

    for (i = 0; i < nent; i++) {
        unsigned long base = buf + 8 + (unsigned long)i * sizeof(struct kvm_cpuid_entry2);
        long w[5];
        int j;
        for (j = 0; j < 5; j++) {
            w[j] = peek_word(pid, base + (unsigned long)j * 8);
            if (w[j] == -1 && errno) { fprintf(stderr, "[D] peek entry fail %s\n", strerror(errno)); return; }
        }
        memcpy(&entries[i], w, sizeof(struct kvm_cpuid_entry2));
    }

    for (i = 0; i < nent; i++) adjust_entry(&entries[i]);
    write = 0;
    for (i = 0; i < nent; i++) {
        if (should_remove(&entries[i])) continue;
        if (write != i) entries[write] = entries[i];
        write++;
    }

    for (i = 0; i < write; i++) {
        unsigned long base = buf + 8 + (unsigned long)i * sizeof(struct kvm_cpuid_entry2);
        long w[5];
        int j;
        memcpy(w, &entries[i], sizeof(struct kvm_cpuid_entry2));
        for (j = 0; j < 5; j++) poke_word(pid, base + (unsigned long)j * 8, w[j]);
    }

    long new_word0 = (word0 & 0xffffffff00000000UL) | (long)write;
    poke_word(pid, buf, new_word0);
    fprintf(stderr, "[D] filtered %u -> %u entries (pid=%d)\n", nent, write, pid);
}

static pid_t seccomp_pid = 0;
static int expect_exit = 0;

static void handle_stop(pid_t pid, int status) {
    unsigned int event = (unsigned int)(status >> 16);

    if (event == PTRACE_EVENT_SECCOMP) {
        fprintf(stderr, "[D] SECCOMP event pid=%d\n", pid);
        seccomp_pid = pid;
        expect_exit = 1;
        ptrace(PTRACE_SYSCALL, pid, 0, 0);
        return;
    }
    if (event == PTRACE_EVENT_FORK || event == PTRACE_EVENT_VFORK ||
        event == PTRACE_EVENT_CLONE || event == PTRACE_EVENT_EXEC) {
        fprintf(stderr, "[D] fork/exec event pid=%d event=%u\n", pid, event);
        ptrace(PTRACE_CONT, pid, 0, 0);
        return;
    }
    if (event == PTRACE_EVENT_EXIT) {
        fprintf(stderr, "[D] EXIT event pid=%d\n", pid);
        ptrace(PTRACE_CONT, pid, 0, 0);
        return;
    }

    if (expect_exit && pid == seccomp_pid) {
        /* SECCOMP stop 后 PTRACE_SYSCALL 产生的 stop 是该 ioctl 的 exit stop。
         * 用 GETREGS 判断: exit 时 rax = 返回值（ioctl 成功返回 0），rdx = buffer 指针 */
        struct user_regs_struct regs;
        if (ptrace(PTRACE_GETREGS, pid, 0, &regs) == 0) {
            fprintf(stderr, "[D] exit stop pid=%d rax=%#llx rdx=%#llx\n",
                    pid, (unsigned long long)regs.rax, (unsigned long long)regs.rdx);
            if ((long)regs.rax == 0) {
                modify_cpuid_buffer(pid, (unsigned long)regs.rdx);
            } else {
                fprintf(stderr, "[D] ioctl returned %lld (errno=%ld)\n", (long long)regs.rax, (long)regs.rax);
            }
        }
        expect_exit = 0;
        seccomp_pid = 0;
    } else {
        fprintf(stderr, "[D] other stop pid=%d status=%#x event=%u\n", pid, status, event);
    }
    ptrace(PTRACE_CONT, pid, 0, 0);
}

int main(void) {
    struct sockaddr_un addr;
    int lfd, cfd;
    pid_t target = 0;
    char buf[128];

    setbuf(stderr, NULL);
    mkdir("/run/xensemble", 0755);
    unlink(SOCK_PATH);
    lfd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (lfd < 0) { perror("socket"); return 1; }
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, SOCK_PATH, sizeof(addr.sun_path) - 1);
    if (bind(lfd, (struct sockaddr *)&addr, sizeof(addr)) != 0) { perror("bind"); return 1; }
    if (listen(lfd, 4) != 0) { perror("listen"); return 1; }
    fprintf(stderr, "[D] listening on %s\n", SOCK_PATH);

    while (1) {
        /* 等待注入库连接（blink-server 每次启动都会连接） */
        cfd = accept(lfd, NULL, NULL);
        if (cfd < 0) { perror("accept"); sleep(1); continue; }
        ssize_t r = read(cfd, buf, sizeof(buf) - 1);
        if (r <= 0) { close(cfd); continue; }
        buf[r] = 0;
        fprintf(stderr, "[D] got: %s", buf);
        if (sscanf(buf, "READY %d", &target) != 1 || target <= 0) {
            close(cfd);
            continue;
        }

        if (ptrace(PTRACE_SEIZE, target, 0, 0) != 0) {
            fprintf(stderr, "[D] SEIZE fail: %s\n", strerror(errno));
            close(cfd);
            continue;
        }
        if (ptrace(PTRACE_INTERRUPT, target, 0, 0) != 0) {
            fprintf(stderr, "[D] INTERRUPT fail: %s\n", strerror(errno));
            close(cfd);
            continue;
        }
        {
            int istatus;
            pid_t ipid = waitpid(target, &istatus, __WALL);
            fprintf(stderr, "[D] waitpid(target)=%d status=%#x event=%u\n",
                    ipid, istatus, ipid == target ? (unsigned)(istatus >> 16) : 0);
        }
        if (ptrace(PTRACE_SETOPTIONS, target, 0,
                   (void *)(long)(PTRACE_O_TRACESECCOMP | PTRACE_O_TRACEFORK |
                                  PTRACE_O_TRACEVFORK | PTRACE_O_TRACECLONE |
                                  PTRACE_O_TRACEEXEC)) != 0) {
            fprintf(stderr, "[D] SETOPTIONS fail: %s\n", strerror(errno));
            close(cfd);
            continue;
        }
        fprintf(stderr, "[D] attached to pid %d\n", target);

        if (write(cfd, "OK\n", 3) != 3) { close(cfd); continue; }
        close(cfd);

        if (ptrace(PTRACE_CONT, target, 0, 0) != 0) {
            fprintf(stderr, "[D] CONT fail: %s\n", strerror(errno));
        }

        /* 事件循环：处理目标进程及子进程事件，直到目标退出 */
        while (1) {
            int status;
            pid_t pid = waitpid(-1, &status, __WALL);
            if (pid < 0) {
                if (errno == EINTR) continue;
                fprintf(stderr, "[D] waitpid err: %s\n", strerror(errno));
                break;
            }
            if (WIFSTOPPED(status)) {
                handle_stop(pid, status);
            } else if (pid == target) {
                /* 目标进程退出（blink 重启），重新等待连接 */
                fprintf(stderr, "[D] target %d exited, waiting for next connection\n", target);
                break;
            } else {
                fprintf(stderr, "[D] non-stop pid=%d status=%#x\n", pid, status);
            }
        }
    }
    return 0;
}
