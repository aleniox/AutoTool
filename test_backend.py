from fastapi.testclient import TestClient
from backend.server.app import app

def test_api():
    with TestClient(app) as client:
        # Health check
        res = client.get("/api/health")
        assert res.status_code == 200, f"Health failed: {res.text}"
        data = res.json()
        print("[OK] /api/health OK:", data.get('node'), "uptime:", data.get('uptimeSec'))

        # Platforms
        res = client.get("/api/platforms")
        assert res.status_code == 200, f"Platforms failed: {res.text}"
        platforms = res.json().get('platforms', [])
        print(f"[OK] /api/platforms OK: {len(platforms)} platforms found ({[p['name'] for p in platforms]})")

        # Stats
        res = client.get("/api/stats")
        assert res.status_code == 200, f"Stats failed: {res.text}"
        stats = res.json()
        print("[OK] /api/stats OK: accounts:", stats.get('counts', {}).get('accounts'))

        # Accounts
        res = client.get("/api/accounts")
        assert res.status_code == 200, f"Accounts failed: {res.text}"
        accounts = res.json().get('accounts', [])
        print(f"[OK] /api/accounts OK: {len(accounts)} accounts found")

        # Targets
        res = client.get("/api/targets")
        assert res.status_code == 200, f"Targets failed: {res.text}"
        targets = res.json().get('targets', [])
        print(f"[OK] /api/targets OK: {len(targets)} targets found")

        # Posts
        res = client.get("/api/posts")
        assert res.status_code == 200, f"Posts failed: {res.text}"
        posts = res.json().get('posts', [])
        print(f"[OK] /api/posts OK: {len(posts)} posts found")

        # Jobs
        res = client.get("/api/jobs")
        assert res.status_code == 200, f"Jobs failed: {res.text}"
        jobs = res.json().get('jobs', [])
        print(f"[OK] /api/jobs OK: {len(jobs)} jobs found")

        # Settings
        res = client.get("/api/settings")
        assert res.status_code == 200, f"Settings failed: {res.text}"
        print("[OK] /api/settings OK")

        # AI Settings
        res = client.get("/api/ai/settings")
        assert res.status_code == 200, f"AI settings failed: {res.text}"
        ai_data = res.json()
        assert 'hasKey' in ai_data and 'model' in ai_data, f"Invalid AI settings response: {ai_data}"
        print("[OK] /api/ai/settings OK (model:", ai_data.get('model'), ")")

        # AI Generate validation (should reject without API key)
        res = client.post("/api/ai/generate", json={"apiKey": "", "topic": "test"})
        # Should either require key or succeed if key exists
        assert res.status_code in (200, 400), f"AI generate unexpected status: {res.status_code}"
        print("[OK] /api/ai/generate endpoint tested OK")

        # Calendar API
        res = client.get("/api/calendar?month=2026-10")
        assert res.status_code == 200, f"Calendar failed: {res.text}"
        cal_data = res.json()
        assert 'items' in cal_data and 'month' in cal_data, f"Invalid calendar response: {cal_data}"
        print(f"[OK] /api/calendar OK: {len(cal_data['items'])} items found in {cal_data['month']}")

        # Web SPA Index
        res = client.get("/")
        assert res.status_code == 200, f"SPA failed: {res.text}"
        assert "<title>" in res.text or "<!DOCTYPE html>" in res.text or "<html" in res.text
        print("[OK] GET / (SPA index.html) OK")

        print("\nALL API TESTS PASSED SUCCESSFULLY! OK")

if __name__ == "__main__":
    test_api()
