# LabMonitor

LabMonitor 是一个面向 Linux GPU 服务器的实时资源监控 Web 应用。前端使用 React、TypeScript、Tailwind CSS 和 Vite；后端使用 FastAPI、psutil，并通过 `nvidia-smi` 的 CSV 结构化查询接口读取 GPU 和计算进程信息。

## 功能

- CPU 使用率与逻辑/物理核心数、内存用量、各磁盘挂载点容量、系统运行时间。
- GPU 型号、利用率、显存、温度、功耗和进程列表；空闲判断同时考虑 GPU 利用率和显存占用。
- 每张 GPU 卡片显示最近 30 秒的利用率与显存占用曲线（按 3 秒采样，曲线使用平滑插值）。
- 默认每 3 秒刷新，支持手动刷新、浅色/深色主题和 GPU 详情查看。
- GPU 查询失败时显示不可用状态，CPU、内存和磁盘数据仍会单独读取。
- 只读取资源信息，不提供或执行终止 GPU 进程等系统状态修改操作。

## Linux 启动

需要 Python 3.8+、Node.js 16+ / npm，以及 NVIDIA 驱动和 `nvidia-smi`（GPU 数据所需）。首次启动会创建 Python 虚拟环境并安装依赖，同时安装前端 npm 依赖：

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
