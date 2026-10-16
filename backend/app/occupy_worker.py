from __future__ import annotations

import argparse
import time


def main() -> None:
    parser = argparse.ArgumentParser(description="LabMonitor GPU occupancy worker")
    parser.add_argument("--gb", type=float, required=True, help="显存占用量，单位 GB")
    parser.add_argument("--device", type=int, required=True, help="GPU 编号")
    parser.add_argument("--matmul-size", type=int, default=8192, help="矩阵乘法规模")
    parser.add_argument("--sleep", type=float, default=0.0, help="每轮计算后的暂停秒数")
    args = parser.parse_args()
    if args.gb <= 0 or args.device < 0 or args.matmul_size < 256 or args.sleep < 0:
        raise ValueError("占用参数无效")

    try:
        import torch
    except ImportError as exc:
        raise RuntimeError("当前 GPU Python 解释器没有安装 PyTorch；请设置 LABMONITOR_GPU_PYTHON") from exc
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA 不可用")

    torch.cuda.set_device(args.device)
    device = f"cuda:{args.device}"
    print(f"使用设备: {device}", flush=True)
    num_elements = int(args.gb * 1024**3 / 4)
    memory_block = torch.empty(num_elements, dtype=torch.float32, device=device)
    memory_block.fill_(1.0)
    print(f"已占用约 {args.gb:.2f} GB 显存", flush=True)

    n = args.matmul_size
    a = torch.randn((n, n), dtype=torch.float16, device=device)
    b = torch.randn((n, n), dtype=torch.float16, device=device)
    print(f"开始持续矩阵乘法: {n} x {n}", flush=True)
    print("按 Ctrl+B 后按 D 可退出 tmux，使用 stop 按钮会释放占用", flush=True)

    counter = 0
    try:
        while True:
            c = torch.matmul(a, b)
            if counter % 100 == 0:
                torch.cuda.synchronize()
                _ = c[0, 0].item()
            counter = (counter + 1) % 1000
            if args.sleep > 0:
                time.sleep(args.sleep)
    except KeyboardInterrupt:
        print("退出，释放显存和计算资源", flush=True)


if __name__ == "__main__":
    main()
