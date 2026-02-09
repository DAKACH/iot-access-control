from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional, Literal

from fastapi import FastAPI, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from sqlalchemy import (
    create_engine, Column, Integer, String, DateTime, Boolean, Text, desc, func
)
from sqlalchemy.orm import declarative_base, sessionmaker

# ===================== Config =====================
DB_URL = "sqlite:///./iot.db"         # SQLite file will be created next to this script
WEB_DIR = "web"                       # folder that contains index.html + js + css
Base = declarative_base()
engine = create_engine(DB_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

# ===================== DB Models =====================
class AccessLog(Base):
    __tablename__ = "access_logs"
    id = Column(Integer, primary_key=True)
    time = Column(DateTime, nullable=False, index=True)        # stored as naive UTC
    device_id = Column(String(64), nullable=False, index=True)
    uid = Column(String(64), nullable=True, index=True)
    result = Column(String(16), nullable=False, index=True)    # GRANTED / DENIED
    rssi = Column(Integer, nullable=True)

class Heartbeat(Base):
    __tablename__ = "heartbeats"
    id = Column(Integer, primary_key=True)
    time = Column(DateTime, nullable=False, index=True)        # stored as naive UTC
    device_id = Column(String(64), nullable=False, index=True)
    door_status = Column(String(16), nullable=False)           # CLOSED / OPEN / LOCKDOWN
    ip = Column(String(64), nullable=True)

class ControlCmd(Base):
    __tablename__ = "control_cmds"
    id = Column(Integer, primary_key=True)
    device_id = Column(String(64), nullable=False, index=True)
    cmd = Column(String(32), nullable=False)                   # open / lockdown_on / lockdown_off / buzzer_test
    created_at = Column(DateTime, nullable=False, index=True)
    consumed = Column(Boolean, default=False, index=True)
    payload = Column(Text, nullable=True)

Base.metadata.create_all(bind=engine)

# ===================== API Schemas =====================
class AccessIn(BaseModel):
    deviceId: str = Field(..., alias="deviceId")
    uid: Optional[str] = None
    status: str  # "authorized" / "unauthorized"

class HeartbeatIn(BaseModel):
    deviceId: str = Field(..., alias="deviceId")
    doorStatus: str = Field(..., alias="doorStatus")

class ControlIn(BaseModel):
    deviceId: str
    cmd: Literal["open", "lockdown_on", "lockdown_off", "buzzer_test"]

# ===================== App =====================
app = FastAPI(title="IoT Access Server", version="1.0")

# Allow ESP32 + browser dashboard
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # in production: replace with your dashboard origin(s)
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc):
    # Return JSON for API paths to help debugging
    if request.url.path.startswith("/api/"):
        return JSONResponse(status_code=500, content={"ok": False, "error": str(exc)})
    # For non-API, return a simple 500
    return JSONResponse(status_code=500, content={"ok": False, "error": "Internal Server Error"})



def utcnow():
    # store naive UTC so it works nicely with SQLite without timezone quirks
    return datetime.now(timezone.utc).replace(tzinfo=None)

def normalize_range(r: str) -> str:
    r = (r or "").strip()
    return r if r in ("1h", "24h", "7d") else "24h"

def parse_range_to_start(range_: str) -> datetime:
    range_ = normalize_range(range_)
    now = utcnow()
    if range_ == "1h":
        return now - timedelta(hours=1)
    if range_ == "7d":
        return now - timedelta(days=7)
    # default 24h
    return now - timedelta(hours=24)

# ===================== ESP32 endpoints =====================
@app.post("/api/access")
def api_access(payload: AccessIn = Body(...)):
    # Map ESP32 status -> dashboard result
    status = (payload.status or "").lower()
    result = "GRANTED" if status == "authorized" else "DENIED"

    db = SessionLocal()
    try:
        row = AccessLog(
            time=utcnow(),
            device_id=payload.deviceId,
            uid=(payload.uid or "").strip().upper() if payload.uid else None,
            result=result,
            rssi=None,
        )
        db.add(row)
        db.commit()
        return {"ok": True, "id": row.id}
    finally:
        db.close()

@app.post("/api/heartbeat")
def api_heartbeat(payload: HeartbeatIn = Body(...)):
    db = SessionLocal()
    try:
        hb = Heartbeat(
            time=utcnow(),
            device_id=payload.deviceId,
            door_status=(payload.doorStatus or "CLOSED").strip().upper(),
            ip=None,
        )
        db.add(hb)
        db.commit()
        return {"ok": True}
    finally:
        db.close()

# ===================== Dashboard endpoints =====================
@app.get("/api/logs")
def api_logs(
    limit: int = Query(80, ge=1, le=500),
    time_range: str = Query("24h", alias="range"),
):
    time_range = normalize_range(time_range)
    start = parse_range_to_start(time_range)
    db = SessionLocal()
    try:
        rows = (
            db.query(AccessLog)
            .filter(AccessLog.time >= start)
            .order_by(desc(AccessLog.time))
            .limit(limit)
            .all()
        )
        return [
            {
                "time": r.time.isoformat() + "Z",
                "device_id": r.device_id,
                "uid": r.uid,
                "result": r.result,
                "rssi": r.rssi,
            }
            for r in rows
        ]
    finally:
        db.close()

@app.get("/api/stats")
def api_stats(time_range: str = Query("24h", alias="range")):
    start = parse_range_to_start(time_range)
    db = SessionLocal()
    try:
        total = db.query(func.count(AccessLog.id)).filter(AccessLog.time >= start).scalar() or 0
        granted = (
            db.query(func.count(AccessLog.id))
            .filter(AccessLog.time >= start, AccessLog.result == "GRANTED")
            .scalar()
            or 0
        )
        denied = total - granted

        # time series buckets
        now = utcnow()
        if time_range == "1h":
            buckets = 12
            step = timedelta(minutes=5)
        elif time_range == "7d":
            buckets = 14
            step = timedelta(hours=12)
        else:
            buckets = 24
            step = timedelta(hours=1)

        base = now - (buckets * step)
        series = []
        for i in range(buckets):
            t0 = base + (i * step)
            t1 = t0 + step
            g = (
                db.query(func.count(AccessLog.id))
                .filter(AccessLog.time >= t0, AccessLog.time < t1, AccessLog.result == "GRANTED")
                .scalar()
                or 0
            )
            d = (
                db.query(func.count(AccessLog.id))
                .filter(AccessLog.time >= t0, AccessLog.time < t1, AccessLog.result == "DENIED")
                .scalar()
                or 0
            )
            series.append({"time": t1.isoformat() + "Z", "granted": g, "denied": d})

        return {"total": total, "granted": granted, "denied": denied, "timeseries": series}
    finally:
        db.close()

# ===================== Security Analytics Endpoint =====================
@app.get("/api/security")
def api_security(time_range: str = Query("24h", alias="range")):
    """Analyze access patterns and calculate security risk score"""
    start = parse_range_to_start(time_range)
    db = SessionLocal()
    try:
        now = utcnow()
        
        # Get all logs in range
        logs = db.query(AccessLog).filter(AccessLog.time >= start).order_by(desc(AccessLog.time)).all()
        
        total = len(logs)
        denied = sum(1 for log in logs if log.result == "DENIED")
        granted = total - denied
        
        # Calculate failure rate
        failure_rate = (denied / total * 100) if total > 0 else 0
        
        # Detect Brute Force: UIDs with 3+ failed attempts
        uid_failures = {}
        for log in logs:
            if log.result == "DENIED" and log.uid:
                uid_failures[log.uid] = uid_failures.get(log.uid, 0) + 1
        
        brute_force_uids = [uid for uid, count in uid_failures.items() if count >= 3]
        brute_force_count = len(brute_force_uids)
        
        # Detect suspicious time (2AM - 5AM attempts)
        suspicious_hours = []
        for log in logs:
            hour = log.time.hour
            if 2 <= hour <= 5:
                suspicious_hours.append({
                    "time": log.time.isoformat() + "Z",
                    "uid": log.uid,
                    "result": log.result
                })
        
        # Detect rapid attempts (same UID, multiple attempts within 2 minutes)
        rapid_attempts = []
        uid_times = {}
        for log in logs:
            if log.uid:
                if log.uid not in uid_times:
                    uid_times[log.uid] = []
                uid_times[log.uid].append(log.time)
        
        for uid, times in uid_times.items():
            if len(times) >= 3:
                times_sorted = sorted(times)
                for i in range(len(times_sorted) - 2):
                    if (times_sorted[i + 2] - times_sorted[i]).total_seconds() < 120:
                        if uid not in rapid_attempts:
                            rapid_attempts.append(uid)
        
        # Calculate Risk Score (0-100)
        risk_score = 0
        
        # Factor 1: Failure rate (up to 30 points)
        risk_score += min(30, failure_rate * 0.6)
        
        # Factor 2: Brute force attempts (up to 35 points)
        risk_score += min(35, brute_force_count * 12)
        
        # Factor 3: Suspicious hours activity (up to 20 points)
        risk_score += min(20, len(suspicious_hours) * 5)
        
        # Factor 4: Rapid attempts (up to 15 points)
        risk_score += min(15, len(rapid_attempts) * 5)
        
        risk_score = min(100, round(risk_score))
        
        # Determine risk level
        if risk_score >= 70:
            risk_level = "CRITICAL"
        elif risk_score >= 50:
            risk_level = "HIGH"
        elif risk_score >= 25:
            risk_level = "MEDIUM"
        else:
            risk_level = "LOW"
        
        # Build alerts list
        alerts = []
        if brute_force_count > 0:
            alerts.append({
                "type": "BRUTE_FORCE",
                "severity": "HIGH",
                "message": f"{brute_force_count} UID(s) avec tentatives répétées",
                "uids": brute_force_uids[:5]
            })
        
        if len(suspicious_hours) > 0:
            alerts.append({
                "type": "SUSPICIOUS_TIME", 
                "severity": "MEDIUM",
                "message": f"{len(suspicious_hours)} tentative(s) en heures suspectes (2h-5h)",
                "count": len(suspicious_hours)
            })
        
        if len(rapid_attempts) > 0:
            alerts.append({
                "type": "RAPID_ATTEMPTS",
                "severity": "HIGH", 
                "message": f"{len(rapid_attempts)} UID(s) avec tentatives rapides",
                "uids": rapid_attempts[:5]
            })
        
        if failure_rate > 40:
            alerts.append({
                "type": "HIGH_FAILURE_RATE",
                "severity": "MEDIUM",
                "message": f"Taux d'échec élevé: {failure_rate:.1f}%",
                "rate": failure_rate
            })
        
        return {
            "risk_score": risk_score,
            "risk_level": risk_level,
            "total_attempts": total,
            "granted": granted,
            "denied": denied,
            "failure_rate": round(failure_rate, 1),
            "alerts": alerts,
            "brute_force_uids": brute_force_uids[:10],
            "suspicious_hours_count": len(suspicious_hours),
            "rapid_attempts_count": len(rapid_attempts)
        }
    finally:
        db.close()

@app.post("/api/control/queue")
def api_control_queue(payload: ControlIn):
    db = SessionLocal()
    try:
        row = ControlCmd(
            device_id=payload.deviceId,
            cmd=payload.cmd,
            created_at=utcnow(),
            consumed=False,
            payload=None,
        )
        db.add(row)
        db.commit()
        return {"ok": True, "queued": row.id}
    finally:
        db.close()

@app.get("/api/control/pending")
def api_control_pending(deviceId: str = Query(..., alias="deviceId")):
    db = SessionLocal()
    try:
        row = (
            db.query(ControlCmd)
            .filter(ControlCmd.device_id == deviceId, ControlCmd.consumed == False)  # noqa: E712
            .order_by(ControlCmd.created_at.asc())
            .first()
        )
        if not row:
            return {"cmd": None}

        row.consumed = True
        db.commit()
        return {"cmd": row.cmd}
    finally:
        db.close()

# ===================== Serve Static Files (MUST BE LAST) =====================
# Mount static files AFTER all API routes to ensure API routes take precedence
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")

# ===================== Run with: python server.py =====================
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=3000, reload=False)
