/*
 * seccomp-trace-inject.c
 * LD_PRELOAD 注入库：加载到 blink-server，启动时安装 seccomp filter。
 * filter 只对 ioctl(KVM_GET_SUPPORTED_CPUID) 返回 SECCOMP_RET_TRACE，
 * 其他 syscall 全部 ALLOW（性能≈0）。
 *
 * 时序：constructor 连接守护进程 socket → 发 READY <pid> →
 *       等守护进程 attach 完成 → 安装 filter。
 *
 * 编译: gcc -shared -fPIC -O2 -o seccomp-trace-inject.so seccomp-trace-inject.c
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>
#include <sys/syscall.h>
#include <stddef.h>

#define SOCK_PATH "/run/xensemble/seccomp-trace.sock"
/* _IOWR(0xAE, 0x05, struct kvm_cpuid2) */
#define KVM_GET_SUPPORTED_CPUID_IOCTL 0xC008AE05UL

static void install_filter(void) {
    struct sock_filter filter[] = {
        /* [0] 检查架构 */
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        /* [3] syscall == ioctl? */
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_ioctl, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        /* [6] args[1] == KVM_GET_SUPPORTED_CPUID? */
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (unsigned int)KVM_GET_SUPPORTED_CPUID_IOCTL, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_TRACE),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog prog = {
        .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
        .filter = filter,
    };
    if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog) != 0) {
        fprintf(stderr, "[seccomp-inject] filter install FAILED: %s\n", strerror(errno));
    } else {
        fprintf(stderr, "[seccomp-inject] seccomp filter installed (ioctl=%#x -> TRACE)\n",
                (unsigned int)KVM_GET_SUPPORTED_CPUID_IOCTL);
    }
}

#define HANDSHAKE_ENV "XENSEMBLE_SECCOMP_HANDSHAKE_DONE"

__attribute__((constructor))
static void init(void) {
    /* fork/exec 子进程会继承 LD_PRELOAD 与本标记：跳过握手，避免
     * 子进程（如 image disk 构建时的 cp）阻塞在等 daemon 的 OK 回复。
     * 只有首个进程（blink-server）需要安装 seccomp filter。 */
    if (getenv(HANDSHAKE_ENV)) return;
    setenv(HANDSHAKE_ENV, "1", 1);

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return;

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, SOCK_PATH, sizeof(addr.sun_path) - 1);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        /* 守护进程未运行：跳过，不装 filter（blink 可正常启动，只是 CPUID 不过滤） */
        fprintf(stderr, "[seccomp-inject] daemon not reachable (%s), skipping filter\n", strerror(errno));
        close(fd);
        return;
    }

    /* 发 READY <pid>，等守护进程 attach 完成 */
    char msg[64];
    int n = snprintf(msg, sizeof(msg), "READY %d\n", (int)getpid());
    if (write(fd, msg, (size_t)n) != n) {
        close(fd);
        return;
    }

    char buf[16] = {0};
    ssize_t r = read(fd, buf, sizeof(buf) - 1);
    if (r > 0 && strncmp(buf, "OK", 2) == 0) {
        install_filter();
    } else {
        fprintf(stderr, "[seccomp-inject] daemon handshake failed (got '%s')\n", buf);
    }
    close(fd);
}
