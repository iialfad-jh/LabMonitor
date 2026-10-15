import os

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=os.getenv("LABMONITOR_HOST", "0.0.0.0"),
        port=int(os.getenv("LABMONITOR_PORT", "8000")),
        reload=False,
        access_log=False,
        log_level="warning",
    )
