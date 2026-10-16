# LabMonitor

LabMonitor 是一个面向 Linux GPU 服务器的实时资源监控 Web 应用。前端使用 React、TypeScript、Tailwind CSS 和 Vite；后端使用 FastAPI、psutil，并通过 `nvidia-smi` 的 CSV 结构化查询接口读取 GPU 和计算进程信息。

## 功能

- CPU 使用率与逻辑/物理核心数、内存用量、各磁盘挂载点容量、系统运行时间。
- GPU 型号、利用率、显存、温度、功耗和进程列表；空闲判断同时考虑 GPU 利用率和显存占用。
- 每张 GPU 卡片显示最近 30 秒的利用率与显存占用曲线：每 3 秒采样，画面独立逐帧向左平滑滚动，横轴不显示时间文字。未采集的区间留空，窗口外的数据自动裁剪。
- 默认每 3 秒刷新，支持手动刷新、浅色/深色主题和 GPU 详情查看。
- 空卡提醒：选择指定 GPU 或任意一张 GPU，设置空闲显存阈值，支持网页提示、提示音及浏览器桌面通知。
- 占用卡：选择一张 GPU 和预占用显存大小；目标卡可用显存达到条件后自动在 `tmux` 中启动 PyTorch 显存占用与矩阵计算任务，页面返回会话名称，可复制 `tmux attach -t 会话名` 查看，也可删除会话释放占用。
- GPU 查询失败时显示不可用状态，CPU、内存和磁盘数据仍会单独读取。
- 监控详情只读取资源信息；占用卡只管理 LabMonitor 自己创建的 tmux 会话，不提供终止其他 GPU 进程的功能。

## 空卡提醒

在服务器概览下方选择目标卡（指定一张或任意一张），设置“空闲显存大于 X GB”，再点击“开启提醒”。空闲显存按 `(显存总量 - 已用显存) / 1024` 计算，与 GPU 利用率是不同指标；满足显存条件不代表 GPU 算力完全空闲，也不会为你预留资源。

开启后从下一次成功采集开始判断，严格大于阈值才触发。采集失败、显存不可用时等待数据恢复，不使用旧数据触发。触发一次后停止监测，可点击“再次提醒”重新开启，也可随时点击“停止提醒”。

- 网页提示始终启用；提示音可选，建议用于通过 `http://服务器IP:端口` 访问的场景。
- 桌面通知可选，需要浏览器支持、授予权限，并通过 HTTPS 或 localhost 访问。普通服务器 IP 的 HTTP 页面通常无法启用此功能。
- 监测仅在当前页面打开时生效，刷新或关闭页面会取消规则。后台标签页可能被浏览器降低刷新频率，提示音和通知也可能受浏览器、系统静音或勿扰模式影响。

## 占用卡

“占用卡”会在后台持续检查目标 GPU。只要可用显存达到“预占用量 + 0.5 GB 启动余量”，就会创建 `labmonitor-gpu-编号` tmux 会话；GPU 利用率只表示当前算力负载，不会阻止显存足够时启动。任务会保留显存并持续矩阵乘法，因此会同时占用显存和算力；页面上的“停止占用”会删除这个会话并释放资源。

需要服务器安装 `tmux`，并准备一个安装了支持当前 GPU 架构的 PyTorch、CUDA 可用的 Python 解释器。启动脚本的 FastAPI 虚拟环境不会自动安装体积较大的 PyTorch；占用卡会自动检查 `/opt/conda/envs/*/bin/python` 和系统 Python，并选择能运行当前 GPU 的环境。如果自动检查不到合适环境，请这样启动：

```bash
LABMONITOR_GPU_PYTHON=/opt/conda/bin/python ./start.sh
```

可选环境变量：`LABMONITOR_OCCUPANCY_POLL_SECONDS`（默认 3 秒）、`LABMONITOR_OCCUPANCY_SAFETY_GB`（默认 0.5 GB）、`LABMONITOR_OCCUPANCY_MATMUL_SIZE`（默认 8192）。矩阵规模越大，计算负载越高，也需要更多额外显存。API 重启后仍会显示名称以 `labmonitor-gpu-` 开头的现有会话，但无法恢复由旧进程提交的预占用量；请通过页面停止或手动执行 `tmux kill-session -t 会话名`。

占用 worker 的输出会同时显示在 tmux 中，并记录到项目根目录的 `logs/labmonitor-gpu-编号.log`。如果 PyTorch 与 GPU 架构不兼容，页面会显示具体错误，而不会只显示“会话已结束”。也可以通过 `LABMONITOR_LOG_DIR` 指定其他日志目录。

如果需要手动查看正在运行的任务：

```bash
tmux attach -t labmonitor-gpu-0
```

退出查看但保持任务运行可按 `Ctrl+B` 后按 `D`；不要直接在 tmux 中按 `Ctrl+C`，除非希望停止该占用进程。

## Linux 启动

需要 Python 3.8+、Node.js 16+ / npm，以及 NVIDIA 驱动和 `nvidia-smi`（GPU 数据所需）。如果要使用“占用卡”，还需要 `tmux` 和单独的 PyTorch/CUDA Python 环境。首次启动会创建 Python 虚拟环境并安装依赖，同时安装前端 npm 依赖：

```bash
chmod +x start.sh
./start.sh
```

启动脚本会打印实际访问地址。默认前端地址是 `http://服务器IP:5173`，后端 API 是 `http://服务器IP:8000`；如果端口已被占用，脚本会自动选择下一个可用端口并打印新地址。这里的“服务器IP”必须替换为服务器实际可访问的 IPv4 地址，不能直接输入这几个中文字符。前端开发服务器将 `/api` 请求代理到本机 FastAPI。

在前台运行 `./start.sh` 时，按 `Ctrl+C` 会同时停止前端和后端。如果曾经用 `nohup` 或后台方式启动，请先找到启动脚本进程，再执行 `kill <start.sh进程PID>`；脚本的清理逻辑会停止它启动的两个子服务：

```bash
ps -ef | grep '[s]tart.sh'
kill 12345
```

如果浏览器就在服务器上，使用 `http://127.0.0.1:实际前端端口`。如果从其他电脑访问，使用启动脚本打印的服务器 IPv4 地址，例如 `http://100.67.244.25:5174`；这个地址必须能从客户端路由到，并且服务器或云安全组需要放行对应端口。若服务器运行在容器、远程开发环境或 NAT 后面，还需要配置端口转发，容器内显示的 IP 不一定能从外部电脑直接访问。

后端默认关闭每次请求的访问日志，只保留警告和错误；前端 Vite 也不会重复输出开发服务器日志。`8000` 如果被服务器上其他程序占用，LabMonitor 会自动改用下一个可用端口；关闭 LabMonitor 不会影响那个其他程序。

排查时可以在服务器上执行：

```bash
ss -ltnp | grep -E ':5173|:5174|:8000|:8001'
curl --noproxy '*' http://127.0.0.1:实际前端端口/
curl --noproxy '*' http://127.0.0.1:实际API端口/api/health
```

如果本机 `curl` 成功、其他电脑失败，应用本身已经启动，问题在网络路由、防火墙或端口转发。若当前终端设置了 HTTP 代理，测试本机服务时请保留 `--noproxy '*'`。

可以通过环境变量更改监听地址与端口：

```bash
LABMONITOR_HOST=0.0.0.0 LABMONITOR_PORT=9000 LABMONITOR_WEB_PORT=5174 ./start.sh
```

`LABMONITOR_HOST` 是 FastAPI 的监听地址，设为 `0.0.0.0` 可从其他电脑访问。若 API 位于不同主机，可设置 `LABMONITOR_API_TARGET=http://API主机:端口`。服务没有登录功能，请按服务器环境自行限制网络访问。

启动脚本默认让 Vite 使用轮询监听文件，兼容 Linux 服务器常见的 inotify watcher 数量限制；本地开发时可用 `LABMONITOR_USE_POLLING=false` 切换回原生文件监听。

## 分开启动

后端：

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
LABMONITOR_HOST=0.0.0.0 LABMONITOR_PORT=8000 python run.py
```

前端（另开终端）：

```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

打开 `http://服务器IP:5173`。FastAPI 健康检查地址为 `/api/health`，实时指标接口为 `/api/metrics`。可用 `LABMONITOR_CORS_ORIGINS` 配置逗号分隔的 API 跨域来源；使用 Vite 同源代理时无需额外设置。

## 前端生产构建

```bash
cd frontend
npm run build
```

构建产物位于 `frontend/dist`。部署静态文件时需将 `/api` 反向代理到 FastAPI。`frontend/vite.config.ts` 中的 `/api` 代理仅用于本地开发服务器。
