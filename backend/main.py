"""Cloud Vault Browser Capture — FastAPI application entry point."""

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from config import get_config
from db import Database


@asynccontextmanager
async def lifespan(app: FastAPI):
    config = get_config()
    db = Database(config.db_path)
    db.init_schema()
    app.state.db = db
    yield


app = FastAPI(
    title="Cloud Vault Browser Capture",
    version="0.1.0",
    description="Browser capture API for Cloud Vault investment research pipeline",
    lifespan=lifespan,
)

config = get_config()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

from routes.health import router as health_router
from routes.capture import router as capture_router
from routes.captures import router as captures_router

app.include_router(health_router)
app.include_router(capture_router, prefix="/capture")
app.include_router(captures_router, prefix="/captures")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.host, port=config.port, log_level=config.log_level)
