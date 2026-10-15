from __future__ import annotations

import csv
import io
import os
import platform
import socket
import subprocess
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import psutil
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

NVIDIA_TIMEOUT_SECONDS = 4
GPU_FIELDS = [
    "index",
    "uuid",
    "name",
    "utilization.gpu",
    "memory.used",
    "memory.total",
    "temperature.gpu",
    "power.draw",
    "power.limit",
]

app = FastAPI(title="LabMonitor API", version="1.0.0")
origins = [value.strip() for value in os.getenv("LABMONITOR_CORS_ORIGINS", "*").split(",") if value.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins or ["*"],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


def _number(value: Any) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in {"n/a", "[not supported]", "[not found]", "not available"}:
        return None
    try:
        result = float(text)
        return result if result >= 0 else None
    except (TypeError, ValueError):
        return None


def _whole(value: Optional[float]) -> Optional[int]:
    return int(value) if value is not None else None


def _run_nvidia_query(query: str) -> List[List[str]]:
    result = subprocess.run(
        ["nvidia-smi", query, "--format=csv,noheader,nounits"],
        check=True,
        capture_output=True,
        text=True,
        timeout=NVIDIA_TIMEOUT_SECONDS,
    )
    return list(csv.reader(io.StringIO(result.stdout), skipinitialspace=True))


def _gpu_snapshot() -> Dict[str, Any]:
    try:
        rows = _run_nvidia_query("--query-gpu=" + ",".join(GPU_FIELDS))
    except FileNotFoundError:
        return {"available": False, "gpus": [], "error": "未找到 nvidia-smi，GPU 数据不可用。"}
    except subprocess.TimeoutExpired:
        return {"available": False, "gpus": [], "error": "nvidia-smi 查询超时，GPU 数据不可用。"}
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip().splitlines()
        message = detail[-1] if detail else "nvidia-smi 查询失败。"
        return {"available": False, "gpus": [], "error": message[:240]}
    except OSError as exc:
        return {"available": False, "gpus": [], "error": "nvidia-smi 执行失败：{}".format(exc)}

    processes_by_uuid: Dict[str, List[Dict[str, Any]]] = {}
    process_error = None
    try:
        process_rows = _run_nvidia_query("--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory")
    except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError):
        process_rows = []
        process_error = "GPU 进程信息暂时不可用，设备指标仍可查看。"
    for row in process_rows:
        if len(row) < 4:
            continue
        uuid, raw_pid, process_name, raw_memory = [cell.strip() for cell in row[:4]]
        try:
            pid = int(raw_pid)
        except ValueError:
            continue
        try:
            username = psutil.Process(pid).username()
        except (psutil.Error, KeyError, OSError):
            username = None
        processes_by_uuid.setdefault(uuid, []).append(
            {
                "pid": pid,
                "username": username,
                "name": process_name if process_name and process_name != "[Not Found]" else None,
                "memory_used_mb": _number(raw_memory),
            }
        )

    gpus = []
    for row in rows:
        if len(row) < len(GPU_FIELDS):
            row = row + [""] * (len(GPU_FIELDS) - len(row))
        index_text, uuid, name = [str(value).strip() for value in row[:3]]
        try:
            index = int(index_text)
        except ValueError:
            continue
        utilization = _whole(_number(row[3]))
        memory_used = _number(row[4])
        memory_total = _number(row[5])
        temp = _whole(_number(row[6]))
        power = _number(row[7])
        power_limit = _number(row[8])

        if utilization is None or memory_used is None or memory_total is None:
            status = "unknown"
        else:
            memory_threshold = max(512.0, memory_total * 0.05)
            status = "idle" if utilization < 5 and memory_used < memory_threshold else "busy"
        gpus.append(
            {
                "index": index,
                "uuid": uuid or None,
                "name": name or None,
                "utilization_percent": utilization,
                "memory_used_mb": memory_used,
                "memory_total_mb": memory_total,
                "temperature_c": temp,
                "power_w": power,
                "power_limit_w": power_limit,
                "status": status,
                "processes": processes_by_uuid.get(uuid, []),
                "processes_available": process_error is None,
            }
        )
    return {"available": True, "gpus": gpus, "error": process_error}


def _disk_snapshot() -> List[Dict[str, Any]]:
    disks = []
    seen = set()
    try:
        partitions = psutil.disk_partitions(all=False)
    except (OSError, psutil.Error):
        partitions = []
    for partition in partitions:
        mountpoint = partition.mountpoint
        if mountpoint in seen:
            continue
        seen.add(mountpoint)
        try:
            usage = psutil.disk_usage(mountpoint)
            disks.append(
                {
                    "device": partition.device,
                    "mountpoint": mountpoint,
                    "filesystem": partition.fstype or None,
                    "used_bytes": usage.used,
                    "total_bytes": usage.total,
                    "free_bytes": usage.free,
                    "usage_percent": usage.percent,
                    "available": True,
                }
            )
        except (OSError, PermissionError, psutil.Error):
            disks.append(
                {
                    "device": partition.device,
                    "mountpoint": mountpoint,
                    "filesystem": partition.fstype or None,
                    "used_bytes": None,
                    "total_bytes": None,
                    "free_bytes": None,
                    "usage_percent": None,
                    "available": False,
                }
            )
    return disks


@app.get("/api/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "service": "LabMonitor API"}


@app.get("/api/metrics")
def metrics() -> Dict[str, Any]:
    errors: Dict[str, str] = {}
    try:
        cpu_percent = psutil.cpu_percent(interval=0.1)
        cpu_logical = psutil.cpu_count(logical=True)
        cpu_physical = psutil.cpu_count(logical=False)
    except (OSError, psutil.Error) as exc:
        cpu_percent = cpu_logical = cpu_physical = None
        errors["cpu"] = "CPU 指标读取失败：{}".format(exc)
    try:
        memory = psutil.virtual_memory()
        memory_data = {"total_bytes": memory.total, "used_bytes": memory.used, "available_bytes": memory.available, "usage_percent": memory.percent}
    except (OSError, psutil.Error) as exc:
        memory_data = {"total_bytes": None, "used_bytes": None, "available_bytes": None, "usage_percent": None}
        errors["memory"] = "内存指标读取失败：{}".format(exc)

    try:
        disks = _disk_snapshot()
        if not disks:
            errors["disks"] = "未发现可读取的磁盘挂载点。"
    except Exception as exc:  # keep CPU and GPU data available if one collector fails
        disks = []
        errors["disks"] = "磁盘指标读取失败：{}".format(exc)

    gpu_data = _gpu_snapshot()
    if not gpu_data["available"]:
        errors["gpus"] = gpu_data["error"] or "GPU 数据不可用。"
    elif gpu_data.get("error"):
        errors["gpu_processes"] = gpu_data["error"]

    gpus = gpu_data["gpus"]
    idle_count = sum(1 for gpu in gpus if gpu["status"] == "idle")
    gpu_count = len(gpus) if gpu_data["available"] else None
    try:
        uptime_seconds = max(0, int(time.time() - psutil.boot_time()))
    except (OSError, psutil.Error):
        uptime_seconds = None

    return {
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "hostname": socket.gethostname(),
        "platform": platform.platform(),
        "system_uptime_seconds": uptime_seconds,
        "cpu": {"usage_percent": cpu_percent, "logical_cores": cpu_logical, "physical_cores": cpu_physical},
        "memory": memory_data,
        "disks": disks,
        "gpu_available": gpu_data["available"],
        "gpu_count": gpu_count,
        "idle_gpu_count": idle_count if gpu_data["available"] else None,
        "gpus": gpus,
        "errors": errors,
    }
