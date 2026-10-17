"""
OpenWrite Mobile - Backend API Bridge
Wraps OpenWrite CLI commands as REST/JSON endpoints for mobile consumption.
"""

import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# OpenWrite core path
OPENWRITE_ROOT = Path(__file__).resolve().parents[2] / "Openwrite"
OPENWRITE_CLI = [sys.executable, "-m", "tools.cli"]

app = FastAPI(
    title="OpenWrite Mobile API",
    version="1.0.0",
    description="Mobile bridge for OpenWrite novel writing engine"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class NovelCreate(BaseModel):
    title: str
    description: Optional[str] = ""
    genre: Optional[str] = ""


class ChapterWrite(BaseModel):
    novel_id: str
    chapter_number: int
    prompt: Optional[str] = ""
    model: Optional[str] = "deepseek-chat"


class ReviewRequest(BaseModel):
    novel_id: str
    chapter_number: int
    model: Optional[str] = "deepseek-chat"


class ModelConfig(BaseModel):
    api_key: str
    base_url: Optional[str] = "https://api.deepseek.com"
    model: Optional[str] = "deepseek-chat"


def run_openwrite(command: list, cwd: Path = OPENWRITE_ROOT) -> dict:
    """Execute OpenWrite CLI command and return structured result."""
    try:
        env = os.environ.copy()
        # Ensure UTF-8
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        
        result = subprocess.run(
            [sys.executable, "-m", "tools.cli"] + command,
            cwd=cwd,
            capture_output=True,
            text=True,
            env=env,
            timeout=300
        )
        
        return {
            "success": result.returncode == 0,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Command timed out after 300s"}
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.get("/api/health")
def health_check():
    """Check if OpenWrite core is accessible."""
    result = run_openwrite(["--version"])
    return {
        "status": "ok" if result["success"] else "error",
        "openwrite": result["stdout"].strip() if result["success"] else None,
        "version": "1.0.0"
    }


@app.get("/api/novels")
def list_novels():
    """List all novels in the data directory."""
    novels_dir = OPENWRITE_ROOT / "data" / "novels"
    novels = []
    
    if novels_dir.exists():
        for novel_dir in novels_dir.iterdir():
            if novel_dir.is_dir():
                readme = novel_dir / "README.md"
                title = novel_dir.name
                if readme.exists():
                    try:
                        content = readme.read_text(encoding="utf-8")
                        lines = content.strip().split("\n")
                        if lines:
                            title = lines[0].replace("#", "").strip()
                    except:
                        pass
                
                novels.append({
                    "id": novel_dir.name,
                    "title": title,
                    "path": str(novel_dir),
                    "modified": datetime.fromtimestamp(novel_dir.stat().st_mtime).isoformat()
                })
    
    return {"novels": sorted(novels, key=lambda x: x["modified"], reverse=True)}


@app.post("/api/novels")
def create_novel(novel: NovelCreate):
    """Initialize a new novel project."""
    novel_id = novel.title.strip().replace(" ", "_").lower()
    
    result = run_openwrite(["init", novel_id])
    
    if not result["success"]:
        raise HTTPException(status_code=500, detail=result.get("stderr", "Init failed"))
    
    # Write description if provided
    if novel.description:
        novel_dir = OPENWRITE_ROOT / "data" / "novels" / novel_id
        readme = novel_dir / "README.md"
        if readme.exists():
            content = readme.read_text(encoding="utf-8")
            content += f"\n\n{novel.description}"
            readme.write_text(content, encoding="utf-8")
    
    return {
        "success": True,
        "id": novel_id,
        "message": f"Novel '{novel.title}' created"
    }


@app.get("/api/novels/{novel_id}")
def get_novel(novel_id: str):
    """Get novel details including chapters and metadata."""
    novel_dir = OPENWRITE_ROOT / "data" / "novels" / novel_id
    
    if not novel_dir.exists():
        raise HTTPException(status_code=404, detail="Novel not found")
    
    # Get README
    readme = novel_dir / "README.md"
    description = ""
    if readme.exists():
        description = readme.read_text(encoding="utf-8")
    
    # Scan for chapters
    chapters = []
    src_dir = novel_dir / "src"
    if src_dir.exists():
        for ch_file in sorted(src_dir.glob("ch*.md")):
            chapter_num = int(ch_file.stem.replace("ch", ""))
            content = ch_file.read_text(encoding="utf-8")
            title_line = content.split("\n")[0] if content else f"Chapter {chapter_num}"
            title = title_line.replace("#", "").strip()
            
            chapters.append({
                "number": chapter_num,
                "title": title,
                "word_count": len(content),
                "modified": datetime.fromtimestamp(ch_file.stat().st_mtime).isoformat()
            })
    
    return {
        "id": novel_id,
        "description": description,
        "chapters": chapters,
        "chapter_count": len(chapters)
    }


@app.get("/api/novels/{novel_id}/chapters/{chapter_num}")
def get_chapter(novel_id: str, chapter_num: int):
    """Get chapter content."""
    chapter_file = OPENWRITE_ROOT / "data" / "novels" / novel_id / "src" / f"ch{chapter_num}.md"
    
    if not chapter_file.exists():
        raise HTTPException(status_code=404, detail="Chapter not found")
    
    content = chapter_file.read_text(encoding="utf-8")
    lines = content.split("\n")
    title = lines[0].replace("#", "").strip() if lines else f"Chapter {chapter_num}"
    
    return {
        "novel_id": novel_id,
        "number": chapter_num,
        "title": title,
        "content": content,
        "word_count": len(content)
    }


@app.post("/api/novels/{novel_id}/write")
def write_chapter(novel_id: str, chapter: ChapterWrite, background_tasks: BackgroundTasks):
    """Queue chapter writing task."""
    # Set environment for model
    env = os.environ.copy()
    if chapter.model:
        env["LLM_MODEL"] = chapter.model
    
    # Start writing in background
    def do_write():
        cmd = ["write", str(chapter.chapter_number), "--novel", novel_id]
        if chapter.prompt:
            cmd.extend(["--prompt", chapter.prompt])
        run_openwrite(cmd)
    
    background_tasks.add_task(do_write)
    
    return {
        "success": True,
        "message": f"Writing chapter {chapter.chapter_number} queued",
        "status": "processing"
    }


@app.post("/api/novels/{novel_id}/review")
def review_chapter(novel_id: str, review: ReviewRequest):
    """Review a chapter."""
    result = run_openwrite([
        "review", str(review.chapter_number),
        "--novel", novel_id
    ])
    
    if not result["success"]:
        raise HTTPException(status_code=500, detail=result.get("stderr", "Review failed"))
    
    return {
        "success": True,
        "review": result["stdout"],
        "novel_id": novel_id,
        "chapter": review.chapter_number
    }


@app.get("/api/novels/{novel_id}/characters")
def list_characters(novel_id: str):
    """List characters in a novel."""
    chars_dir = OPENWRITE_ROOT / "data" / "novels" / novel_id / "src" / "characters"
    characters = []
    
    if chars_dir.exists():
        for char_file in chars_dir.glob("*.md"):
            content = char_file.read_text(encoding="utf-8")
            lines = content.split("\n")
            name = char_file.stem
            if lines:
                first_line = lines[0].replace("#", "").strip()
                if first_line:
                    name = first_line
            
            characters.append({
                "id": char_file.stem,
                "name": name,
                "file": str(char_file),
                "preview": content[:200] + "..." if len(content) > 200 else content
            })
    
    return {"characters": characters}


@app.get("/api/novels/{novel_id}/outline")
def get_outline(novel_id: str):
    """Get novel outline."""
    outline_file = OPENWRITE_ROOT / "data" / "novels" / novel_id / "src" / "outline.md"
    
    if not outline_file.exists():
        return {"outline": "", "exists": False}
    
    return {
        "outline": outline_file.read_text(encoding="utf-8"),
        "exists": True
    }


@app.post("/api/model/configure")
def configure_model(config: ModelConfig):
    """Configure AI model settings."""
    # Save to environment or config file
    config_file = OPENWRITE_ROOT / "config" / "model_config.json"
    config_file.parent.mkdir(parents=True, exist_ok=True)
    
    config_data = {
        "api_key": config.api_key,
        "base_url": config.base_url,
        "model": config.model,
        "updated": datetime.now().isoformat()
    }
    
    config_file.write_text(json.dumps(config_data, indent=2, ensure_ascii=False), encoding="utf-8")
    
    # Set environment
    os.environ["LLM_API_KEY"] = config.api_key
    os.environ["LLM_BASE_URL"] = str(config.base_url or "")
    os.environ["LLM_MODEL"] = str(config.model or "")
    
    return {"success": True, "message": "Model configured"}


@app.get("/api/model/status")
def get_model_status():
    """Get current model configuration status."""
    config_file = OPENWRITE_ROOT / "config" / "model_config.json"
    
    if not config_file.exists():
        return {
            "configured": False,
            "message": "No model configured"
        }
    
    config = json.loads(config_file.read_text(encoding="utf-8"))
    # Mask API key
    masked_key = config["api_key"][:8] + "..." + config["api_key"][-4:] if len(config["api_key"]) > 12 else "***"
    
    return {
        "configured": True,
        "model": config.get("model", "unknown"),
        "base_url": config.get("base_url", ""),
        "api_key_preview": masked_key,
        "updated": config.get("updated", "")
    }


@app.get("/api/stats")
def get_stats():
    """Get global writing statistics."""
    novels_dir = OPENWRITE_ROOT / "data" / "novels"
    total_novels = 0
    total_chapters = 0
    total_words = 0
    
    if novels_dir.exists():
        for novel_dir in novels_dir.iterdir():
            if novel_dir.is_dir():
                total_novels += 1
                src_dir = novel_dir / "src"
                if src_dir.exists():
                    for ch_file in src_dir.glob("ch*.md"):
                        total_chapters += 1
                        content = ch_file.read_text(encoding="utf-8")
                        total_words += len(content)
    
    return {
        "total_novels": total_novels,
        "total_chapters": total_chapters,
        "total_words": total_words,
        "estimated": True
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=4567)
