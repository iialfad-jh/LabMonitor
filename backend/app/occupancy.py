from __future__ import annotations

import math
import os
import glob
import shlex
import shutil
import subprocess
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple


SnapshotFactory = Callable[[], Dict[str, Any]]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _free_gb(gpu: Dict[str, Any]) -> Optional[float]:
    used = gpu.get("memory_used_mb")
    total = gpu.get("memory_total_mb")
    if not isinstance(used, (int, float)) or not isinstance(total, (int, float)):
        return None
    if not math.isfinite(used) or not math.isfinite(total) or total <= 0 or used < 0 or used > total:
        return None
    return (total - used) / 1024


@dataclass
class Reservation:
    gpu_index: int
    gb: float
    session_name: str
    state: str = "waiting"
    message: str = "等待目标 GPU 有足够可用显存"
    free_gb: Optional[float] = None
    log_path: Optional[str] = field(default=None, repr=False)
    started_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)
    stop_event: threading.Event = field(default_factory=threading.Event, repr=False)
    thread: Optional[threading.Thread] = field(default=None, repr=False)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "gpu_index": self.gpu_index,
            "gb": round(self.gb, 2),
            "session_name": self.session_name,
            "state": self.state,
            "message": self.message,
            "free_gb": round(self.free_gb, 2) if self.free_gb is not None else None,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
        }


class OccupancyManager:
    """Starts one controlled GPU reservation session per GPU.

    The watcher stays in the FastAPI process, while the actual CUDA work runs
    in a detached tmux session. That keeps API requests responsive and lets a
    user inspect the worker with ``tmux attach -t <session_name>``.
    """

    def __init__(self, snapshot_factory: SnapshotFactory) -> None:
        self._snapshot_factory = snapshot_factory
        self._lock = threading.RLock()
        self._reservations: Dict[int, Reservation] = {}
        self._poll_seconds = max(1.0, float(os.getenv("LABMONITOR_OCCUPANCY_POLL_SECONDS", "3")))
        self._safety_gb = max(0.1, float(os.getenv("LABMONITOR_OCCUPANCY_SAFETY_GB", "0.5")))
        configured_python = os.getenv("LABMONITOR_GPU_PYTHON", "").strip()
        self._python_override: Optional[str] = configured_python or None
        self._python: Optional[str] = None
        self._python_checked = False
        self._python_error: Optional[str] = None
        self._matmul_size = max(256, int(os.getenv("LABMONITOR_OCCUPANCY_MATMUL_SIZE", "8192")))
        self._sleep = max(0.0, float(os.getenv("LABMONITOR_OCCUPANCY_SLEEP", "0")))
        project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        self._log_dir = os.getenv("LABMONITOR_LOG_DIR", os.path.join(project_root, "logs"))

    @property
    def safety_gb(self) -> float:
        return self._safety_gb

    def _session_name(self, gpu_index: int) -> str:
        return f"labmonitor-gpu-{gpu_index}"

    @staticmethod
    def _python_candidates() -> List[str]:
        candidates: List[str] = []
        # Conda environments are common on GPU servers and often contain a
        # newer CUDA-enabled PyTorch than the system ``python3``.
        for pattern in ("/opt/conda/envs/*/bin/python", "/opt/conda/envs/*/bin/python3"):
            candidates.extend(sorted(glob.glob(pattern)))
        for command in ("python3", "python"):
            executable = shutil.which(command)
            if executable:
                candidates.append(executable)
        unique: List[str] = []
        for candidate in candidates:
            if candidate not in unique:
                unique.append(candidate)
        return unique

    @staticmethod
    def _check_python(executable: str) -> Tuple[bool, str]:
        check_script = (
            "import torch\n"
            "if not torch.cuda.is_available(): raise SystemExit('CUDA unavailable')\n"
            "capability = torch.cuda.get_device_capability(0)\n"
            "arch = 'sm_%d%d' % capability\n"
            "if arch not in torch.cuda.get_arch_list(): raise SystemExit('PyTorch does not support ' + arch)\n"
            "print(torch.__version__)\n"
        )
        try:
            result = subprocess.run(
                [executable, "-c", check_script],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env={**os.environ, "PYTHONWARNINGS": "ignore"},
                check=False,
                timeout=8,
            )
        except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
            return False, str(exc)
        if result.returncode == 0:
            return True, (result.stdout or "").strip()
        detail = (result.stderr or result.stdout or "PyTorch CUDA compatibility check failed").strip().splitlines()
        return False, detail[-1][:180] if detail else "PyTorch CUDA compatibility check failed"

    def _ensure_gpu_python(self) -> Optional[str]:
        if self._python_checked:
            return self._python
        self._python_checked = True
        failures: List[str] = []
        candidates = [self._python_override] if self._python_override else self._python_candidates()
        for candidate in candidates:
            if not candidate:
                continue
            compatible, detail = self._check_python(candidate)
            if compatible:
                self._python = candidate
                return candidate
            failures.append(f"{candidate}: {detail}")
        self._python_error = (
            "未找到支持当前 GPU 架构的 PyTorch Python 环境。"
            "请设置 LABMONITOR_GPU_PYTHON 指向可用解释器。"
        )
        if failures:
            self._python_error += " " + failures[-1]
        return None

    def _has_session(self, session_name: str) -> bool:
        try:
            result = subprocess.run(
                ["tmux", "has-session", "-t", session_name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=2,
            )
            return result.returncode == 0
        except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
            return False

    def _session_names(self) -> List[str]:
        try:
            result = subprocess.run(
                ["tmux", "list-sessions", "-F", "#S"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                check=False,
                timeout=2,
            )
            if result.returncode != 0:
                return []
            return [line.strip() for line in result.stdout.splitlines() if line.strip().startswith("labmonitor-gpu-")]
        except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
            return []

    def _tmux_available(self) -> bool:
        try:
            result = subprocess.run(
                ["tmux", "-V"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=2
            )
            return result.returncode == 0
        except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
            return False

    def _stop_session(self, session_name: str) -> bool:
        if not session_name.startswith("labmonitor-gpu-"):
            return False
        try:
            result = subprocess.run(
                ["tmux", "kill-session", "-t", session_name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=2,
            )
            return result.returncode == 0
        except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
            return False

    def _set_state(self, reservation: Reservation, state: str, message: str, free_gb: Optional[float] = None) -> None:
        with self._lock:
            reservation.state = state
            reservation.message = message
            reservation.free_gb = free_gb
            reservation.updated_at = _now()

    def start(self, gpu_index: int, gb: float) -> Dict[str, Any]:
        if not isinstance(gpu_index, int) or gpu_index < 0:
            raise ValueError("GPU 编号无效。")
        if not isinstance(gb, (int, float)) or not math.isfinite(gb) or gb <= 0:
            raise ValueError("预占用显存必须大于 0 GB。")
        if not self._tmux_available():
            raise RuntimeError("未找到 tmux，请先安装 tmux 后再开启占用。")

        snapshot = self._snapshot_factory()
        if not snapshot.get("available"):
            raise RuntimeError(snapshot.get("error") or "GPU 数据不可用，无法开启占用。")
        gpu = next((item for item in snapshot.get("gpus", []) if item.get("index") == gpu_index), None)
        if gpu is None:
            raise ValueError("目标 GPU 不存在或当前不可用。")
        total = gpu.get("memory_total_mb")
        if not isinstance(total, (int, float)) or not math.isfinite(total) or total <= 0:
            raise ValueError("目标 GPU 的显存总量不可用。")
        if gb + self._safety_gb >= total / 1024:
            raise ValueError(f"预占用显存需小于 GPU 总显存并预留 {self._safety_gb:.1f} GB。")
        if self._ensure_gpu_python() is None:
            raise RuntimeError(self._python_error or "没有可用的 GPU Python 环境。")

        session_name = self._session_name(gpu_index)
        with self._lock:
            current = self._reservations.get(gpu_index)
            if current and current.state in {"waiting", "starting", "occupied"}:
                raise RuntimeError(f"GPU {gpu_index} 已有占用任务（{current.session_name}）。")
            if self._has_session(session_name):
                raise RuntimeError(f"tmux 会话 {session_name} 已存在，请先停止它。")
            reservation = Reservation(gpu_index=gpu_index, gb=float(gb), session_name=session_name)
            self._reservations[gpu_index] = reservation
            thread = threading.Thread(target=self._watch, args=(reservation,), name=session_name, daemon=True)
            reservation.thread = thread
            thread.start()
        return reservation.as_dict()

    def stop(self, gpu_index: int) -> Dict[str, Any]:
        session_name = self._session_name(gpu_index)
        with self._lock:
            reservation = self._reservations.get(gpu_index)
            if reservation:
                reservation.stop_event.set()
                reservation.updated_at = _now()
                if reservation.state in {"waiting", "starting"}:
                    reservation.state = "stopped"
                    reservation.message = "占用等待已停止"
            exists = self._has_session(session_name)
            if exists:
                self._stop_session(session_name)
            if reservation:
                reservation.state = "stopped"
                reservation.message = "tmux 会话已删除" if exists else "占用已停止"
                reservation.updated_at = _now()
                return reservation.as_dict()
        if exists:
            return {
                "gpu_index": gpu_index,
                "gb": None,
                "session_name": session_name,
                "state": "stopped",
                "message": "tmux 会话已删除",
                "free_gb": None,
                "started_at": None,
                "updated_at": _now(),
            }
        raise ValueError("目标 GPU 没有 LabMonitor 占用任务。")

    def _watch(self, reservation: Reservation) -> None:
        while not reservation.stop_event.is_set():
            try:
                snapshot = self._snapshot_factory()
                if reservation.stop_event.is_set():
                    return
                gpu = next((item for item in snapshot.get("gpus", []) if item.get("index") == reservation.gpu_index), None)
                free_gb = _free_gb(gpu) if gpu else None
                # Memory reservation only needs enough free VRAM. GPU utilization
                # describes compute load and must not prevent a safe allocation.
                if snapshot.get("available") and gpu and free_gb is not None:
                    required_gb = reservation.gb + self._safety_gb
                    if free_gb >= required_gb:
                        self._launch(reservation, free_gb)
                        return
                    self._set_state(reservation, "waiting", f"目标 GPU 可用显存不足（需至少 {required_gb:.1f} GB）", free_gb)
                else:
                    self._set_state(reservation, "waiting", "等待目标 GPU 有足够可用显存", free_gb)
            except Exception as exc:  # keep waiting through transient nvidia-smi errors
                self._set_state(reservation, "waiting", f"等待 GPU 数据恢复：{str(exc)[:160]}")
            reservation.stop_event.wait(self._poll_seconds)

    def _launch(self, reservation: Reservation, free_gb: float) -> None:
        with self._lock:
            if reservation.stop_event.is_set():
                return
            reservation.state = "starting"
            reservation.message = "正在创建 tmux 会话"
            reservation.free_gb = free_gb
            reservation.updated_at = _now()
        command = [
            self._python or "python3",
            "-u",
            "-m",
            "app.occupy_worker",
            "--device",
            str(reservation.gpu_index),
            "--gb",
            f"{reservation.gb:.3f}",
            "--matmul-size",
            str(self._matmul_size),
            "--sleep",
            str(self._sleep),
        ]
        try:
            os.makedirs(self._log_dir, exist_ok=True)
            reservation.log_path = os.path.join(self._log_dir, f"labmonitor-gpu-{reservation.gpu_index}.log")
        except OSError as exc:
            self._set_state(reservation, "error", f"创建项目日志目录失败：{exc}", free_gb)
            return
        shell_command = "set -o pipefail; {} 2>&1 | tee {}".format(
            shlex.join(command), shlex.quote(reservation.log_path)
        )
        try:
            result = subprocess.run(
                ["tmux", "new-session", "-d", "-s", reservation.session_name, "--", "bash", "-lc", shell_command],
                cwd=os.path.dirname(os.path.dirname(__file__)),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
                timeout=4,
            )
        except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
            self._set_state(reservation, "error", f"创建 tmux 会话失败：{exc}", free_gb)
            return
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "未知错误").strip().splitlines()
            self._set_state(reservation, "error", f"创建 tmux 会话失败：{detail[-1][:180] if detail else '未知错误'}", free_gb)
            return
        if reservation.stop_event.is_set():
            self._stop_session(reservation.session_name)
            self._set_state(reservation, "stopped", "占用已停止", free_gb)
            return
        self._set_state(reservation, "occupied", "占用运行中，可通过 tmux 查看", free_gb)

    @staticmethod
    def _worker_failure(reservation: Reservation) -> Optional[str]:
        if not reservation.log_path:
            return None
        try:
            with open(reservation.log_path, "r", encoding="utf-8", errors="replace") as handle:
                lines = [line.strip() for line in handle.readlines() if line.strip()]
        except (OSError, UnicodeError):
            return None
        if not any("Traceback" in line or "Error" in line or "Exception" in line for line in lines):
            return None
        detail = next(
            (line for line in reversed(lines) if "Error" in line or "Exception" in line),
            lines[-1] if lines else "占用进程异常退出",
        )
        return f"占用进程启动失败：{detail[:220]}"

    def status(self) -> List[Dict[str, Any]]:
        with self._lock:
            reservations = list(self._reservations.values())
            for reservation in reservations:
                if reservation.state == "occupied" and not self._has_session(reservation.session_name):
                    failure = self._worker_failure(reservation)
                    reservation.state = "error" if failure else "ended"
                    reservation.message = failure or "tmux 会话已结束"
                    reservation.updated_at = _now()
            result = [reservation.as_dict() for reservation in reservations if reservation.state != "stopped"]
        # Sessions can survive an API restart. Surface only our deterministic
        # names and leave their requested amount unknown rather than inventing it.
        for session_name in self._session_names():
            try:
                gpu_index = int(session_name[len("labmonitor-gpu-"):])
            except ValueError:
                continue
            if any(item["session_name"] == session_name for item in result):
                continue
            result.append({
                "gpu_index": gpu_index,
                "gb": None,
                "session_name": session_name,
                "state": "occupied",
                "message": "检测到正在运行的 tmux 会话（占用量未知）",
                "free_gb": None,
                "started_at": None,
                "updated_at": _now(),
            })
        return sorted(result, key=lambda item: item["gpu_index"])
