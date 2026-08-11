# openEuler 5.10 沙箱（boxlite/KVM microVM）启动失败诊断与修复

**日期**：2026-08-07
**状态**：已解决（seccomp CPUID 过滤方案生效）
**适用范围**：openEuler 22.03 LTS SP1（内核 5.10）上运行 xensemble 沙箱（boxlite/libkrunfw）

---

## 1. 问题概述

在 openEuler 22.03 LTS SP1（内核 `5.10.0-136.12.0.86.oe2203sp1`）上，创建 agent 会话失败：

```
BoxLite ensureReady failed: blink request timeout after 60000ms: http://127.0.0.1:8787/api/sessions
```

**最终结论**：openEuler 5.10 KVM 通过 `KVM_GET_SUPPORTED_CPUID` 向 guest 暴露了 60 条 CPUID（含 **AMX**、新拓扑枚举、PMU v8 等新特性），而 5.10 KVM 对这些特性的虚拟化实现不完整。guest 内核（libkrunfw 内嵌的 6.12.76）检测到这些特性后尝试启用，导致启动早期崩溃。Debian 6.1 标准 KVM 只暴露 34 条（无新特性），故正常。

**解决方案**：通过 seccomp + ptrace 拦截 `KVM_GET_SUPPORTED_CPUID`，将返回的 CPUID 从 60 条过滤到 32 条（与 Debian 6.1 一致，移除 AMX/新拓扑/PMU 等），使 guest 内核走与 Debian 相同的初始化路径。

---

## 2. 环境信息

| 项 | 值 |
|---|---|
| 操作系统 | openEuler release 22.03 (LTS-SP1) |
| 内核 | 5.10.0-136.12.0.86.oe2203sp1.x86_64 |
| CPU | Intel Xeon Platinum 8462Y+（Sapphire Rapids） |
| blink-server | v0.3.6（boxlite 0.9.5，libkrunfw 1.5.2，内嵌内核 6.12.76） |
| 对比环境 | Debian 6.1.0（内核 6.1.0-51-cloud-amd64，沙箱正常工作） |

---

## 3. 诊断过程与证据

### 3.1 阶段一：基础环境检查（均正常）

| 检查项 | 结果 |
|---|---|
| blink-server 健康 | `{"status":"ok"}` |
| registry（localhost:5000） | 18 个镜像（box-base + 17 个 agent） |
| KVM 模块 | kvm_intel 加载，`/dev/kvm` 可访问 |
| SELinux | Permissive（无拦截） |
| QEMU VM（centos7-big） | 正常运行（证明 KVM 本身可用） |

### 3.2 阶段二：docker.io 拉取问题（已解决，非根因）

blink-server 的引导根文件系统 `debian:bookworm-slim` 从 `docker.io` 直连拉取（blink 有自己的 OCI 拉取器，**不走 Docker daemon 的镜像加速**）。当前网络无法直连 docker.io。

**临时解决**：将 Docker 拉取的 debian 镜像手动注入 blink 缓存（`image_index` 表 + manifest/config/layer 文件）。

> 注：此问题通过代理可彻底解决（`HTTPS_PROXY=http://127.0.0.1:8081`，由 SOCKS5 转 HTTP 的桥接代理提供）。

### 3.3 阶段三：VM 启动失败定位（strace 铁证）

注入 debian 镜像后，VM 创建成功但 guest 立即退出：

```
[shim] entering VM (krun_start_enter)
[krun] krun_start_enter called
... virtio-mmio 设备初始化 ...
using vcpu exit code: 0        ← vCPU 立即退出
Vmm is stopping.
Console output: empty           ← 0 字节
```

**strace 关键证据**（`KVM_RUN` 只执行 3 次）：

```
KVM_GET_API_VERSION = 12
KVM_SET_USER_MEMORY_REGION x5  → 全部成功
KVM_CREATE_VCPU x4             → fd 29,31,33,35
KVM_SET_CPUID2 {nent=60}       → 60 条 CPUID（关键差异！）
KVM_SET_MSRS = 11
KVM_SET_REGS rip=0x1000123
KVM_RUN x3                     → 然后所有线程 exit(0)
```

**KVM tracepoint 证据**（`kvm_exit`/`kvm_entry`，filter 排除 QEMU）：

```
46,046 行事件，全部来自 fc_vcpu 0（vcpu 1/2/3 从未运行）
22,296 EPT_VIOLATION（正常，按需分页）
  393 EPT_MISCONFIG（GPA=0，疑似异常但非致命）
    0 HLT（guest 从未进入 idle）
无 TRIPLE_FAULT / SHUTDOWN / FAILED_VMENTRY
最后 exit：EXTERNAL_INTERRUPT @ 0xffffffff81987661
```

### 3.4 阶段四：Debian 6.1 对比（排除多个假设）

在 Debian 6.1（正常）环境抓取同样的 trace：

| 指标 | Debian 6.1（正常） | openEuler 5.10（失败） | 结论 |
|---|---|---|---|
| EPT_MISCONFIG | 2246 次 | 393 次 | **排除**（Debian 更多且正常） |
| vCPU 活跃 | **4 个全部**（0:42094, 1:15174, 2:8600, 3:5082） | 只有 vcpu 0 | SMP 差异 |
| HLT | 1424 次 | 0 次 | guest 完整启动 vs 未完成 |
| guest 最终位置 | `0xffffffff8198c5aa`（idle HLT） | `0xffffffff81987661`（中断后停止） | 走了不同路径 |
| CPUID 设置 | **nent=34** | **nent=60** | **关键差异** |
| KVM_RUN 次数 | 1507 | 12 | guest 运行量差异 |

**排除的假设**：
1. ❌ EPT_MISCONFIG 是根因（Debian 更多但正常）
2. ❌ SMP/多 CPU 问题（`maxcpus=1` 内核参数测试无效，guest 走完全相同路径）
3. ❌ 旧版 blink-server（v0.3.2~v0.3.8 底层完全相同：libkrunfw 1.5.2 + 内核 6.12.76 + boxlite 0.9.5）
4. ❌ `quiet` 参数导致 console 空（移除后仍 0 字节，但源码确认 `DEFAULT_KERNEL_CMDLINE` 含 `quiet console=hvc0`）

### 3.5 阶段五：CPUID 差异分析（根因确认）

对比 `KVM_GET_SUPPORTED_CPUID` 完整输出（60 vs 34 条）：

**openEuler 独有的 26 条**：
- `0x1d`（AMX 高级矩阵扩展，idx 0,1）
- `0x1e`、`0x1f`（新 CPU 拓扑枚举，idx 0,1,2）
- `0x0b` idx 1,2（扩展拓扑）
- `0x0d` idx 0x9, 0x11（XSAVE supervisor 状态：CET/AMX）
- `0x07` idx 1（新特性 subleaf）
- `0x0e` ~ `0x1c`（大部分为空 leaf）

**共有但值不同**：
- `0x00` max leaf：`0x1f` vs `0x0d`
- `0x0d` XCR0：`0x202e7` vs `0xe7`（**多了 bit 17 = AMX TMM 状态**）
- `0x07` eax：`1` vs `0`
- `0x0a` PMU：v8 vs 0

**根因**：openEuler 5.10 KVM 报告 **XCR0 bit 17（AMX）** 和 AMX 相关 leaf。AMX 的 KVM 虚拟化支持在 Linux 5.16+ 才成熟，5.10 的实现不完整。guest 内核（6.12.76）检测到 AMX 后尝试启用，触发崩溃。Debian 6.1 KVM 不报告 AMX，故正常。

### 3.6 源码佐证

libkrun 的 CPUID 流程（`libkrun/libkrun/src/vmm/src/linux/vstate.rs`）：

```rust
let supported_cpuid = kvm.get_supported_cpuid(KVM_MAX_CPUID_ENTRIES)...;
// → filter_cpuid → 可选 T2/C3 模板 → KVM_SET_CPUID2
```

libkrun 直接用 `KVM_GET_SUPPORTED_CPUID` 的结果作为 guest CPUID（不做特性裁剪），boxlite 也未暴露 `cpu_template` 配置。因此 guest 拿到的 CPUID 完全取决于 host KVM 报告的内容。

默认内核命令行（`src/vmm/src/vmm_config/kernel_cmdline.rs`）：

```
reboot=k panic=-1 panic_print=0 nomodule console=hvc0 rootfstype=virtiofs rw quiet no-kvmapf
```

---

## 4. 解决方案：seccomp CPUID 过滤

### 4.1 方案演进

| 方案 | 结果 | 原因 |
|---|---|---|
| 手动注入 debian 镜像缓存 | ✅ 解决 docker.io 问题 | 网络绕过 |
| LD_PRELOAD hook ioctl | ❌ 无效 | `KVM_GET_SUPPORTED_CPUID` 由**静态链接的 boxlite-shim**（Go）直接 syscall 调用，不走动态链接 |
| 配置层面限制（cpu_template） | ❌ 无效 | boxlite/blink 未暴露该配置 |
| patch 内核 cmdline（maxcpus=1） | ❌ 无效 | 非 SMP 问题 |
| **seccomp + ptrace 过滤 CPUID** | ✅ **有效** | 内核层拦截，静态二进制也生效 |

### 4.2 实现原理

```
seccomp-trace-inject.so (LD_PRELOAD 到 blink-server，动态链接)
  └─ constructor 连接守护进程 socket → 握手 → 安装 seccomp filter
      （子进程经环境变量守卫跳过握手，见 §8.1）
  └─ filter 只对 ioctl(KVM_GET_SUPPORTED_CPUID) 返回 SECCOMP_RET_TRACE
      └─ 其他 syscall 全部 ALLOW（性能≈0）

seccomp-trace-daemon (systemd 服务)
  └─ PTRACE_SEIZE attach blink-server（TRACESECCOMP + TRACEFORK/CLONE/EXEC）
      └─ shim（静态 Go）调用 ioctl 时 → SECCOMP stop → PTRACE_SYSCALL 执行
          └─ exit stop → PTRACE_POKEDATA 修改 CPUID 缓冲区（60→32 条）
```

关键点：
- **seccomp filter 在 fork/exec 时继承** → 对静态链接的 shim 同样生效
- **只拦截 1 个 ioctl** → 性能开销 ≈ 0
- **PTRACE_SYSCALL 仅在 SECCOMP stop 后使用** → 不会拦截每个 syscall
- 修改用 `PTRACE_POKEDATA`（exit stop 时 `rdx` = buffer 指针）

### 4.3 过滤逻辑

```c
/* 移除 */
- leaf 0x1e ~ 0x1f（含 AMX 0x1d、新拓扑 0x1f、空 leaf；保留 0x0e~0x1d 及 hypervisor/kvm-clock 0x40000000）
- leaf 0x07 idx=1（AMX 特性 subleaf）
- leaf 0x0d idx=0x9, 0x11（XSAVE supervisor 状态：CET/AMX）

/* 保留（之前误删，已修复） */
- leaf 0x40000000~0x400000FF（Hypervisor/kvm-clock，VM 时钟同步必需）
- leaf 0x0b（扩展拓扑，多核 VM 需要）
- leaf 0x0a（PMU，性能计数器）

/* 调整 */
- 0x00 eax -> 0x0d（max leaf）
- 0x0d idx=0 eax -> 0xe7（清除 AMX bit17、bit9）
- 0x07 eax -> 0（无 subleaf）
- 0x01、0x80000006、0x80000008 -> 与 Debian 一致
```

> **2026-08-11 修复**：原版 `should_remove` 用 `fn > 0x0d && fn < 0x80000000` 一次性删除了
> 0x0D 到 0x80000000 之间所有 leaf，包括 Hypervisor/kvm-clock leaf（0x40000000）。
> 导致 VM 内核无法通过 kvm-clock 同步宿主机时间，CLOCK_REALTIME 停在 1999-11-30，
> agent CLI 访问 HTTPS API 时报 `SSL certificate is not yet valid`。
> 同时误删了 leaf 0x0b（CPU 拓扑，影响多核 VM）和 0x0a（PMU）。
> 修复：收窄为 `fn >= 0x1e`，显式保留 `0x40000000~0x400000FF`，移除非 AMX 相关的 0x0b/0x0a 规则。

### 4.4 部署文件

| 文件 | 说明 |
|---|---|
| `deploy/seccomp/seccomp-trace-daemon.c` | 守护进程源码（git 内） |
| `deploy/seccomp/seccomp-trace-inject.c` | 注入库源码（git 内） |
| `deploy/seccomp/install-seccomp.sh` | 编译 + 部署脚本（git 内，**按需手动执行**，install.sh 不调用） |
| `/opt/xensemble/seccomp-trace-daemon` | 守护进程（编译产物，运行位置） |
| `/opt/xensemble/seccomp-trace-inject.so` | 注入库（编译产物，运行位置） |

### 4.5 systemd 配置

`/etc/systemd/system/seccomp-trace.service`：

```ini
[Unit]
Description=XEnsemble seccomp CPUID filter daemon
Before=blink-server.service

[Service]
Type=simple
ExecStart=/opt/xensemble/seccomp-trace-daemon
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/blink-server.service`（新增两行）：

```ini
[Unit]
After=network.target seccomp-trace.service
Wants=seccomp-trace.service

[Service]
Environment=LD_PRELOAD=/opt/xensemble/seccomp-trace-inject.so
```

---

## 5. 验证结果

```
[D] SECCOMP event pid=1670711
[D] exit stop pid=1670711 rax=0 rdx=0x44fd920
[D] filtered 60 -> 32 entries (pid=1670711)   ← CPUID 过滤生效

blink 日志：
Guest initialized successfully
Container initialized container_id=5fa17857...
Box started successfully (first_start=true) box_id=uh23XoD0EMau

session 状态：running=true, status=Running
```

**端到端验证**：通过 web 界面（`http://<IP>:8088`）可正常创建 agent。

---

## 6. 影响范围与回退

### 影响范围

| 组件 | 影响 |
|---|---|
| blink-server + shim（沙箱 VM） | 只受影响（CPUID 过滤） |
| QEMU VM（centos7-big） | **零影响**（独立进程，无 LD_PRELOAD/seccomp） |
| 19 个 docker 容器 | **零影响** |
| xensemble 控制面 | **零影响** |
| 其他系统服务 | **零影响** |

### 功能影响

- guest 沙箱**无 AMX、新拓扑、PMU v8** 等新特性（agent CLI 工具不需要，功能不受影响）
- 性能开销 ≈ 0（每个 VM 创建时只过滤 1 次 ioctl）

### 回退方法

```bash
# 1. 移除 LD_PRELOAD
sed -i '/LD_PRELOAD/d' /etc/systemd/system/blink-server.service

# 2. 移除依赖（可选）
sed -i '/seccomp-trace/d' /etc/systemd/system/blink-server.service

# 3. 停用守护进程
systemctl disable --now seccomp-trace

# 4. 重启 blink
systemctl daemon-reload
systemctl restart blink-server
```

---

### 6.5 完整实现指南（新环境可直接照做）

> 本节提供从零实现的完整步骤：源码 → 编译 → 部署 → 验证 → 排障。
> 目标：在另一台 openEuler 5.10（或其他 KVM 报告 AMX 等新特性的环境）上直接落地，
> 无需重新诊断。
>
> **注意**：本方案的源码和部署脚本已放入 git 仓库（`deploy/seccomp/`），但
> **install.sh 不会自动执行**（seccomp 是特定内核环境的按需 workaround）。
> 需要时手动 `bash deploy/seccomp/install-seccomp.sh`（见 6.5.8）。以下手动步骤用于
> 调试/理解原理，或脚本未覆盖的场景。

### 6.5.1 前置条件

| 项 | 要求 |
|---|---|
| 系统 | Linux x86_64（内核 ≥ 5.3，支持 PTRACE_GET_SYSCALL_INFO；实测环境 5.10） |
| 权限 | root（ptrace attach、seccomp 安装、写 /run） |
| 编译器 | gcc（编译 C 源码） |
| 组件 | blink-server 已安装、沙箱镜像已构建（box-base + 自定义镜像） |
| 目标 | 让 guest 看到的 CPUID 与 Debian 6.1 一致（34 条左右） |

### 6.5.2 源码

创建目录并写入两个源码文件：

```bash
mkdir -p /opt/xensemble
```

#### 文件 1：`/opt/xensemble/seccomp-trace-inject.c`

```c
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
```

#### 文件 2：`/opt/xensemble/seccomp-trace-daemon.c`

```c
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
```

### 6.5.3 编译

```bash
# 编译注入库（动态库，LD_PRELOAD 用）
gcc -shared -fPIC -O2 -o /opt/xensemble/seccomp-trace-inject.so \
    /opt/xensemble/seccomp-trace-inject.c

# 编译守护进程（可执行）
gcc -O2 -o /opt/xensemble/seccomp-trace-daemon \
    /opt/xensemble/seccomp-trace-daemon.c

# 验证
ls -la /opt/xensemble/seccomp-trace-inject.so /opt/xensemble/seccomp-trace-daemon
```

> 依赖：`gcc`、Linux 内核头文件（`linux/kvm.h`、`linux/ptrace.h`、`linux/seccomp.h`）。
> 若缺头文件，安装 `kernel-headers` / `linux-libc-dev`。

### 6.5.4 部署（systemd）

#### 创建守护进程服务

`/etc/systemd/system/seccomp-trace.service`：

```ini
[Unit]
Description=XEnsemble seccomp CPUID filter daemon
Before=blink-server.service

[Service]
Type=simple
ExecStart=/opt/xensemble/seccomp-trace-daemon
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

#### 修改 blink-server 服务

编辑 `/etc/systemd/system/blink-server.service`，在 `[Unit]` 加依赖、`[Service]` 加 LD_PRELOAD：

```ini
[Unit]
Description=Blink sandbox execution plane
After=network.target seccomp-trace.service
Wants=seccomp-trace.service        # 注意用 Wants，不要用 Requires（避免停止联动）

[Service]
Type=simple
User=root
Group=root
ExecStart=/usr/local/bin/blink-server
Environment=BLINK_BIND=127.0.0.1
Environment=LD_PRELOAD=/opt/xensemble/seccomp-trace-inject.so
EnvironmentFile=-/etc/xensemble/blink.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

#### 启用并启动

```bash
systemctl daemon-reload
systemctl enable --now seccomp-trace
systemctl restart blink-server
```

### 6.5.5 验证是否生效

```bash
# 1. 确认注入库已加载（blink-server 日志）
journalctl -u blink-server -n 5 | grep "seccomp filter installed"
# 期望: [seccomp-inject] seccomp filter installed (ioctl=0xc008ae05 -> TRACE)

# 2. 确认守护进程已 attach（seccomp-trace 日志）
journalctl -u seccomp-trace -n 5 | grep "attached to pid"
# 期望: [D] attached to pid <blink_pid>

# 3. 触发一个沙箱 session（用 box-base 或任意镜像）
curl -s -X POST http://127.0.0.1:8787/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"name":"verify-filter","image":"localhost:5000/xensemble/box-base:bookworm","warm":false}'

# 4. 确认 CPUID 被过滤（seccomp-trace 日志）
journalctl -u seccomp-trace -n 10 | grep "filtered"
# 期望: [D] filtered 60 -> 32 entries (pid=<shim_pid>)
# 若输出 "filtered N -> M"，N 应为 60（或主机实际条数），M 应为 32 左右

# 5. 确认 session 成功（返回 box_id 且 VM 启动）
# blink 日志应出现: Box started successfully
```

### 6.5.6 排障指南

| 现象 | 原因 | 处理 |
|---|---|---|
| blink-server 日志无 "seccomp filter installed" | 守护进程未运行（注入库连不上 socket，跳过装 filter） | 先启动 seccomp-trace，再重启 blink-server |
| 日志有 "daemon not reachable" | 同上 | 检查 `/run/xensemble/seccomp-trace.sock` 是否存在；`systemctl start seccomp-trace` |
| 守护进程日志无 "attached to pid" | blink 启动时守护进程未就绪 | 确保 `After=seccomp-trace.service` + `Wants=`；重启 blink |
| session 报 `Error(38)` / ENOSYS | SECCOMP TRACE 但无 tracer（守护进程没 attach） | 重启 blink-server（重新握手）；检查守护进程是否存活 |
| session 报 VM 启动失败（guest 崩溃） | CPUID 未过滤（filter 没装上） | 按上面 1-2 步验证；确认 LD_PRELOAD 生效 |
| 守护进程日志大量 "other stop" | 正常（shim 的 fork/exec 事件） | 无需处理 |
| 守护进程日志无 "SECCOMP event" | 过滤逻辑未触发（shim 没调 ioctl？） | 触发沙箱 session 后再查 |
| blink 卡死（线程全 futex 等待） | 见"遗留问题"（image disk 首次构建慢），与 seccomp 无关 | 等待构建完成或预构建 |
| 停 seccomp-trace 导致 blink 也被停 | 误用了 `Requires=` | 改为 `Wants=`（本文已用 Wants） |

### 6.5.7 环境适配说明

1. **CPUID 过滤规则**（`should_remove` / `adjust_entry`）基于 openEuler 5.10 vs Debian 6.1 的对比。
   新环境若主机 KVM 报告不同条目，建议先运行附录 A 的 `get-cpuid` 程序确认，
   再按需调整过滤逻辑（目标是去掉 guest 内核 6.12.76 不兼容的新特性，重点是 AMX：
   leaf 0x1d、0x0d XCR0 bit17、0x07 idx1、0x1f）。
2. **ioctl 常量** `KVM_GET_SUPPORTED_CPUID` = `0xC008AE05`（x86_64 标准值，跨环境一致）。
3. **架构**：filter 中 `AUDIT_ARCH_X86_64` 仅 x86_64；ARM64 需改 `AUDIT_ARCH_AARCH64` 且
   ioctl 常量可能不同。
4. **守护进程单实例**：确保只有一个 seccomp-trace-daemon 在跑（systemd 管理）。
   残留的测试实例会导致 attach 冲突（strace/gdb 无法 attach）。
5. **`Wants=` vs `Requires=`**：必须用 `Wants=`。`Requires=` 会让"停 seccomp-trace"
   连带停 blink-server（已踩坑）。

### 6.5.8 按需部署（源码已在 git，不随 install.sh 自动执行）

> **设计决策**：seccomp CPUID 过滤是**特定环境的 workaround**（仅当 host KVM 报告
> AMX 等新特性导致 guest 崩溃时需要）。正常内核（如 Debian 6.1、标准 KVM 6.x）
> **不需要**。因此 **install.sh 不自动执行**，遇到问题后按需手动部署。

源码与部署脚本已放入仓库 `deploy/seccomp/`（供按需使用，不随 install.sh 安装）：

```
deploy/seccomp/
├── seccomp-trace-inject.c    # 注入库源码
├── seccomp-trace-daemon.c    # 守护进程源码
└── install-seccomp.sh        # 编译 + systemd 部署（幂等）
```

**何时需要**：沙箱 VM 启动失败，且日志显示 guest 崩溃（vCPU 立即退出、
console 空、`box initialization failed`）。用附录 A 的 `get-cpuid` 确认
`KVM_GET_SUPPORTED_CPUID` 报告了 AMX（leaf 0x1d、0x0d XCR0 bit17 等）→ 需要本方案。

**手动部署**：

```bash
# 1. 部署（编译 + systemd 配置，幂等可重复执行）
bash deploy/seccomp/install-seccomp.sh

# 2. 重启 blink-server 应用 filter
systemctl restart blink-server

# 3. 验证（见 6.5.5）
journalctl -u seccomp-trace | grep filtered
# 期望: filtered 60 -> 32 entries
```

**回退**（新环境不需要时，或想移除）：

```bash
systemctl disable --now seccomp-trace
sed -i '/LD_PRELOAD/d; /seccomp-trace/d' /etc/systemd/system/blink-server.service
systemctl daemon-reload && systemctl restart blink-server
```

**新环境部署流程**：

```bash
git clone <仓库>          # 含全部适配改动 + seccomp 源码（但不会自动装）
bash deploy/install.sh    # 正常部署（不含 seccomp）
# 若沙箱报 guest 崩溃 → 按上述"手动部署"步骤启用 seccomp
```

---

## 7. 遗留问题与建议

1. **根本解决**：换 Debian 12 / openEuler 24.03（标准 KVM 6.x，无此问题）
2. **社区反馈**：可向 openEuler 反馈 KVM `KVM_GET_SUPPORTED_CPUID` 报告 AMX 等特性但实现不完整的问题；向 boxlite 反馈 libkrun 未裁剪 CPUID 特性
3. **docker.io 拉取**：仍需代理（`HTTPS_PROXY`）或本地 registry 提供 `debian:bookworm-slim`（引导根文件系统）
4. **维护**：seccomp 守护进程与 blink-server 存在 `Wants` 依赖（blink 启动时守护进程须先就绪，但停止互不联动），blink 重启时守护进程会自动重新 attach（循环 accept）

## 8. 已知问题与修复记录

### 8.1 新镜像首次构建 image disk 卡死（2026-08-07 修复）

**现象**：首次使用某镜像创建 agent（如 `xensemble/agent-claude-code`）时报
`BoxLite ensureReady failed: blink request timeout after 60000ms: http://127.0.0.1:8787/api/sessions`；
blink 日志停在 `Building image disk for sha256:xxx (first time)`，`cp -a` 子进程
`wchan=unix_stream_data_wait`、`syscall=read(3, buf, 15)`、IO 字节数为 0。

**根因**：`seccomp-trace-inject.so` 的 constructor 在**每个** exec 进程启动时都会执行
（connect daemon socket → 发 `READY <pid>` → `read()` 等 `OK` 回复）。blink 构建
image disk 时 fork+exec 的 `cp`（动态链接）继承了 `LD_PRELOAD`，cp 启动后也去连接
`/run/xensemble/seccomp-trace.sock` 并阻塞等待回复；而 daemon 是单线程，attach 完
blink-server 后一直停在 waitpid 事件循环（daemon.c:222），**不再 accept 新连接**，
cp 永久阻塞，blink 等待 cp 退出 → 整个 session 创建超时。
boxlite-shim 为静态链接（LD_PRELOAD 无效），VM 启动路径不受影响，故只有
"首次构建 image disk" 路径暴露此问题（box-base/my-claude 的 image disk 均在部署
seccomp 之前构建，未触发）。

**修复**：inject.c 的 constructor 增加环境变量守卫
`XENSEMBLE_SECCOMP_HANDSHAKE_DONE`——已设置（子进程继承）则直接跳过握手，
只有首个进程（blink-server）执行握手并安装 filter。重编译 inject.so、重启
blink-server 即可。修复后首次构建 6.7s 完成（层已缓存时）。

**排查要点**：`cat /proc/<cp_pid>/syscall` + `cat /proc/<cp_pid>/wchan` 判断卡点；
`pgrep -f "cp -a --reflink"` 找构建进程。

---

## 附录 A：关键命令

```bash
# KVM tracepoint 抓取
echo 1 > /sys/kernel/debug/tracing/events/kvm/kvm_exit/enable
echo 1 > /sys/kernel/debug/tracing/events/kvm/kvm_entry/enable
echo 'common_pid != <QEMU vCPU PIDs>' > /sys/kernel/debug/tracing/events/kvm/kvm_exit/filter
echo > /sys/kernel/debug/tracing/trace
echo 1 > /sys/kernel/debug/tracing/tracing_on
curl -X POST http://127.0.0.1:8787/api/sessions -H "Content-Type: application/json" \
  -d '{"name":"t","image":"localhost:5000/xensemble/box-base:bookworm"}'
echo 0 > /sys/kernel/debug/tracing/tracing_on
cat /sys/kernel/debug/tracing/trace

# strace KVM ioctl
strace -f -e trace=ioctl -p $(pgrep -x blink-server) -o /tmp/strace.log

# 获取完整 CPUID
cat > /tmp/get-cpuid.c << 'EOF'
#include <stdio.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <linux/kvm.h>
#include <stdlib.h>
#include <unistd.h>
int main() {
    int fd = open("/dev/kvm", O_RDWR);
    struct kvm_cpuid2 *c = malloc(sizeof(*c) + 128 * sizeof(struct kvm_cpuid_entry2));
    c->nent = 128;
    ioctl(fd, KVM_GET_SUPPORTED_CPUID, c);
    printf("nent=%d\n", c->nent);
    for (int i = 0; i < c->nent; i++)
        printf("leaf=0x%08x idx=0x%08x eax=0x%08x ebx=0x%08x ecx=0x%08x edx=0x%08x\n",
               c->entries[i].function, c->entries[i].index, c->entries[i].eax,
               c->entries[i].ebx, c->entries[i].ecx, c->entries[i].edx);
    close(fd);
    return 0;
}
EOF
gcc -o /tmp/get-cpuid /tmp/get-cpuid.c && /tmp/get-cpuid
```

## 附录 B：关键源码位置

| 代码 | 位置 |
|---|---|
| libkrun 默认 cmdline | `libkrun/libkrun/src/vmm/src/vmm_config/kernel_cmdline.rs` |
| libkrun CPUID 获取 | `libkrun/libkrun/src/vmm/src/linux/vstate.rs` |
| krun engine exit 语义 | `boxlite-ai/boxlite/src/boxlite/src/vmm/krun/engine.rs` |
| boxlite VmmConfig | `boxlite-ai/boxlite/src/boxlite/src/vmm/mod.rs` |

### 8.2 沙箱 VM 无网络：blink v0.3.6 硬编码 network=Disabled（2026-08-10 修复）

**现象**：VM 能启动但 VM 内无任何网络接口（`/proc/net/dev` 仅 lo / dummy0，路由表空）；
沙箱内 claude-code / opencode 报
`Unable to connect to API (ConnectionRefused)` / `Cannot connect to API: Unable to connect`；
`curl http://192.168.224.109:3888` 等全部 exit=7。

**根因**：blink-server **v0.3.6** 的 session 创建逻辑将网络**硬编码关闭**：

```rust
// blink v0.3.6 src/core/src/context.rs:75（session_options）
network: NetworkSpec::Disabled,
// 同样：src/core/src/runner.rs:26
```

`POST /api/sessions` 的请求结构只有 `name / image / warm / volumes` 四个字段
（`src/server/src/api/sessions.rs` 的 `OpenSessionRequest`），**无 network / ports**，
客户端传任何网络参数都会被 serde 静默忽略（DB 中 box 配置始终为 `"network": "Disabled"`）。
boxlite 0.9.5 底层有 gvproxy（gvisor-tap-vsock）网络实现（shim 内嵌、支持 `NetworkSpec::Enabled`），
但 blink v0.3.6 未暴露。

**定位方法**：
- `sqlite3 /root/.boxlite/db/boxlite.db "SELECT json_extract(json,'$.options.network') FROM box_config WHERE name='<box>';"` → `Disabled`
- VM 内 `/proc/net/dev`、`/proc/net/route`、`/etc/resolv.conf`（nameserver 192.168.127.1 = boxlite 预设）
- 源码：`gh-proxy.com/https://github.com/EeroEternal/blink/archive/refs/tags/v0.3.6.tar.gz`（或 ghfast.top）

**修复**：升级 blink-server 至 **v0.3.8**（2026-07-24 发布）：
- `OpenSessionRequest` 新增 `network: Option<NetworkConfig>` 与 `resources`，**默认 network=enabled（full egress）**
- 支持 `BLINK_NETWORK` / `BLINK_ALLOW_NET` 环境变量
- boxlite 仍为 0.9.5（shim 与 seccomp 方案完全兼容，升级后 `filtered 60 -> 32` 验证通过）
- `deploy/install-blink-server.sh` 默认版本已改为 v0.3.8

**升级步骤**：
```bash
systemctl stop blink-server
curl -fsSL -o /usr/local/bin/blink-server "https://ghfast.top/https://github.com/EeroEternal/blink/releases/download/v0.3.8/blink-server"
chmod +x /usr/local/bin/blink-server
systemctl start blink-server
```

**验证**：创建 session 后 `sqlite3 ... json_extract(json,'$.options.network')` 应为
`{"Enabled":{"allow_net":[]}}`；VM 内 `curl -w '%{http_code}' http://118.145.228.1:13000/v1/models` 返回 401（可达）。
