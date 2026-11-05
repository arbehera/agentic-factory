# Runbook — rootless Docker in WSL2 for agent-container development

| Item | Value |
|---|---|
| Purpose | Dev host for the Docker executor backend (P0-WP4) and the 20-container load test (P0-WP11) |
| Requirements | Hard rule 6, FR-ORC-013, FR-ORC-014, NFR-004; plan Q-03 (answer: rootless Docker in WSL2 on the dev machine) |
| Applies to | Windows 11 + WSL 2.6+ with the `Ubuntu` distro (24.04) |
| Check | `scripts/dev/check-rootless-docker.sh` (run inside Ubuntu); every step below names the check it makes pass |
| Time | About 30 minutes |

## Why this exists

Hard rule 6 says every agent run happens in its own rootless container with:
- a read-only root filesystem;
- no Docker socket and no host mounts;
- all capabilities dropped and seccomp on;
- a network allow-list;
- CPU, memory and PID limits.

Docker Desktop runs its daemon as root inside its own VM, so it can't show any of that. Worse, Docker Desktop puts its own `docker` CLI into your WSL distros. A container "test" in Ubuntu would quietly run on Docker Desktop and prove nothing.

The setup below gives Ubuntu its own **rootless** Docker daemon, running as your user, and stops Docker Desktop from interfering with that distro. Docker Desktop stays installed for the Windows side.

**What runs where once this is done:**

| Work | Where |
|---|---|
| Editing code, unit tests, PostgreSQL Testcontainers tests | Windows (`D:\adlc\adlc-platform`), as today |
| Executor tests that start agent containers (P0-WP4), load test (P0-WP11), full `pnpm verify` before a PR | Ubuntu, in its own clone (step 9) |

## State of this machine (checked 2026-11-05)

| Check | State |
|---|---|
| WSL 2.6.3, kernel 6.6, Ubuntu 24.04.1 | ✓ |
| systemd is PID 1 (`/etc/wsl.conf` has `[boot] systemd=true`) | ✓ — step 1 is verify-only |
| cgroup v2 unified; `cpu`, `memory`, `pids` delegated to user `arabinda` | ✓ — the delegation part of step 3 is verify-only |
| `/etc/subuid` entry `arabinda:100000:65536` | ✓ |
| `uidmap` package (`newuidmap`) | **missing** → step 3 |
| `docker` in Ubuntu is a symlink into `/mnt/wsl/docker-desktop` | **Docker Desktop integration is on** → step 2 |
| Rootless daemon | **not installed** → steps 4–7 |
| Linux Node.js 22 and pnpm | **missing** (only the Windows ones are visible through PATH interop) → step 8 |

## Steps

Run everything in an **Ubuntu** shell as your normal user, unless a step says PowerShell. Use `sudo` only where it is written.

**Opening the Ubuntu shell:** run `wsl -d Ubuntu` in PowerShell, or open **Ubuntu** from the Start menu or Windows Terminal. The prompt looks like `arabinda@PIN-N0275:~$`; a `PS C:\...>` prompt means you are still in PowerShell. `sudo` asks for your **Ubuntu** password, the one set when the distro was installed, not your Windows password.

### 1. systemd (verify only)

```bash
ps -p 1 -o comm=          # must print: systemd
```

If it doesn't, add this to `/etc/wsl.conf`, then run `wsl --shutdown` in PowerShell and reopen Ubuntu:

```ini
[boot]
systemd=true
```

### 2. Turn off Docker Desktop's integration for Ubuntu

In **Docker Desktop**, go to **Settings → Resources → WSL integration**:
1. Clear **Ubuntu** (and *Enable integration with my default WSL distro*, if it is ticked).
2. Click **Apply & restart**.

Then, in **PowerShell**:

```powershell
wsl --terminate Ubuntu
```

Reopen Ubuntu and check:

```bash
readlink -f "$(command -v docker)" 2>/dev/null || echo "no docker CLI (expected for now)"
# must NOT contain: docker-desktop
```

If the symlink is still there, remove it with `sudo rm /usr/bin/docker`. It belongs to Docker Desktop, not to a package. A Docker Desktop update can turn the integration back on, and the check script will catch that.

### 3. Prerequisites for rootless mode

```bash
sudo apt-get update
sudo apt-get install -y uidmap dbus-user-session slirp4netns fuse-overlayfs ca-certificates curl
```

- `uidmap` provides `newuidmap` and `newgidmap`, which map your sub-UID range into the daemon's user namespace.
- `dbus-user-session` lets `systemctl --user` manage the daemon.
- `slirp4netns` is the user-mode network for rootless containers.

**cgroup delegation (verify only).** Rootless containers can only have CPU, memory and PID limits if systemd delegates those controllers to your user:

```bash
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers
# must include: cpu memory pids
```

If one is missing:

```bash
sudo mkdir -p /etc/systemd/system/user@.service.d
printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
sudo systemctl daemon-reload
```

Then run `wsl --terminate Ubuntu` in PowerShell.

### 4. Install Docker Engine from Docker's repository

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-ce-rootless-extras docker-buildx-plugin
docker --version          # paste the output to the developer running P0-WP4; it is recorded in the
                          # P0-WP4 entry of docs/phase-reports/phase-0-plan.md (and the PR, once there is a remote)
```

`docker-ce-rootless-extras` provides `dockerd-rootless-setuptool.sh` and RootlessKit.

### 5. Turn off the root daemon the package just started

The packages start a **rootful** `dockerd`. Stop and disable it, so the only daemon is the rootless one:

```bash
sudo systemctl disable --now docker.service docker.socket
sudo rm -f /var/run/docker.sock
```

Do **not** add your user to the `docker` group. That group exists to give access to the root daemon.

### 6. Set up the rootless daemon

Run this as yourself, **without** `sudo`:

```bash
dockerd-rootless-setuptool.sh install
systemctl --user enable --now docker
sudo loginctl enable-linger "$(id -un)"     # keep the daemon running without an open login session
echo 'export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock' >> ~/.bashrc
source ~/.bashrc
docker info --format '{{json .SecurityOptions}} cgroup v{{.CgroupVersion}}'
# must show: "name=seccomp,profile=builtin", "name=rootless", and cgroup v2
```

`DOCKER_HOST` is used (rather than only a Docker context) because Testcontainers and the executor's Docker client both read it.

### 7. Prove a hardened container runs

These are the settings the executor will apply to every agent container:

```bash
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 64m --cpus 0.5 --pids-limit 64 --network none hello-world
```

You should see "Hello from Docker!". An error that mentions cgroups or limits means delegation from step 3 is missing.

### 8. Node.js 22 and pnpm inside Ubuntu

WSL appends the Windows PATH, so `node` and `pnpm` can resolve to the Windows binaries under `/mnt/c`. Install Linux ones:

```bash
curl -fsSLo /tmp/nvm-install.sh https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh
less /tmp/nvm-install.sh                  # read it before running it
bash /tmp/nvm-install.sh && source ~/.bashrc
nvm install 22.23.4 && nvm alias default 22.23.4
corepack enable pnpm
command -v node pnpm                      # both must be under ~/.nvm, not /mnt/c
```

Optional: to stop Windows binaries shadowing Linux ones at all, add this to `/etc/wsl.conf` and run `wsl --shutdown`:

```ini
[interop]
appendWindowsPath=false
```

Note that this also removes Windows commands such as `code` and `explorer.exe` from the Ubuntu PATH.

### 9. A Linux clone of the repository

`node_modules` contains OS-specific native binaries (esbuild, for example), so Windows and Linux can't share one checkout. Building on `/mnt/d` is also slow. Clone into the Linux filesystem, using the Windows checkout as the remote (there is no hosted remote yet, plan Q-02):

```bash
mkdir -p ~/src && git clone /mnt/d/adlc/adlc-platform ~/src/adlc-platform
cd ~/src/adlc-platform && pnpm install
```

The Linux clone is a **test runner**: don't edit there. To test a branch that was committed on Windows:

```bash
cd ~/src/adlc-platform && git fetch origin && git checkout -B <branch> origin/<branch> && pnpm install
```

### 10. Final check

```bash
cd ~/src/adlc-platform
scripts/dev/check-rootless-docker.sh     # must end with: All checks passed.
pnpm verify                              # the full gate, now on Linux with rootless Docker
```

## Rollback

```bash
systemctl --user disable --now docker
dockerd-rootless-setuptool.sh uninstall
rootlesskit rm -rf ~/.local/share/docker      # removes rootless images and containers
sudo apt-get remove -y docker-ce docker-ce-cli containerd.io docker-ce-rootless-extras docker-buildx-plugin
```

Then turn Docker Desktop's WSL integration for Ubuntu back on (step 2, reversed).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Check "docker CLI is the distro's own" fails after a Docker Desktop update | The update turned the integration back on. Repeat step 2. |
| `newuidmap: write to uid_map failed` | `uidmap` is missing or `/etc/subuid` has no entry. Repeat step 3, and check `grep $(id -un) /etc/subuid /etc/subgid`. |
| `stat -fc %T /sys/fs/cgroup` prints `tmpfs` (cgroup v1 or hybrid) | In `%UserProfile%\.wslconfig` on Windows, add `[wsl2]` and `kernelCommandLine = cgroup_no_v1=all`, then run `wsl --shutdown`. |
| `--memory`/`--cpus` fail with a cgroup error | Controllers aren't delegated. See step 3. |
| `Cannot connect to the Docker daemon at unix:///run/user/1000/docker.sock` | Run `systemctl --user status docker` and `journalctl --user -u docker`. Check that linger is on (`loginctl show-user $(id -un) -p Linger`). |
| Testcontainers' Ryuk container fails to start | Check that `DOCKER_HOST` is exported in the shell running the tests. As a last resort `TESTCONTAINERS_RYUK_DISABLED=true` works, but test containers are then not cleaned up automatically. Report it if you need this. |

## Known limits that shape P0-WP4

- **Network allow-list.** A rootless daemon can't program the host firewall per container. P0-WP4 therefore enforces the allow-list (gateway, Git, Claude API, pack test targets; FR-ORC-013) with Docker networks plus an egress path through the gateway, and records the design in an ADR. Hard rule 6 is not relaxed.
- **Image signing and digests.** A local registry is used in dev (OPEN-23); it is added with P0-WP4/P0-WP11.
