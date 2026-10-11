import json
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

def parse_time_str(time_str: str) -> tuple[int, int]:
    """Parse 'HH:MM' string to (hour, minute). Defaults to (9, 0)."""
    if not time_str or ':' not in time_str:
        return (9, 0)
    try:
        parts = time_str.strip().split(':')
        h = max(0, min(23, int(parts[0])))
        m = max(0, min(59, int(parts[1])))
        return (h, m)
    except Exception:
        return (9, 0)

def compute_next_run(
    recurring_type: str,
    recurring_time: str,
    recurring_days: Any,
    from_dt: Optional[datetime] = None,
    tz_offset_hours: int = 7  # Default UTC+7 for Vietnam
) -> Optional[datetime]:
    """
    Computes the next occurrence in UTC.
    recurring_type: 'daily' | 'weekly' | 'monthly'
    recurring_time: 'HH:MM' (in local timezone)
    recurring_days: list of ints:
      - weekly: 1..7 (1=Monday, 7=Sunday)
      - monthly: 1..31 (day of month)
    """
    if not recurring_type or recurring_type == 'none':
        return None

    if from_dt is None:
        from_dt = datetime.now(timezone.utc)
    elif from_dt.tzinfo is None:
        from_dt = from_dt.replace(tzinfo=timezone.utc)

    # Convert from_dt to local time
    tz = timezone(timedelta(hours=tz_offset_hours))
    local_from = from_dt.astimezone(tz)

    target_hour, target_minute = parse_time_str(recurring_time)

    # Normalize days
    if isinstance(recurring_days, str):
        try:
            days_list = json.loads(recurring_days)
        except Exception:
            days_list = []
    elif isinstance(recurring_days, list):
        days_list = [int(x) for x in recurring_days if str(x).isdigit()]
    else:
        days_list = []

    if recurring_type == 'daily':
        # Candidate today at target time
        cand = local_from.replace(hour=target_hour, minute=target_minute, second=0, microsecond=0)
        if cand <= local_from + timedelta(seconds=60):
            cand += timedelta(days=1)
        return cand.astimezone(timezone.utc)

    elif recurring_type == 'weekly':
        if not days_list:
            days_list = [local_from.isoweekday()]  # Default to current day of week
        days_set = set(days_list)

        # Check next 14 days
        for i in range(15):
            cand = (local_from + timedelta(days=i)).replace(hour=target_hour, minute=target_minute, second=0, microsecond=0)
            if cand.isoweekday() in days_set:
                if cand > local_from + timedelta(seconds=60):
                    return cand.astimezone(timezone.utc)

    elif recurring_type == 'monthly':
        if not days_list:
            days_list = [local_from.day]
        days_set = set(days_list)

        # Check up to 90 days ahead
        for i in range(95):
            day_dt = local_from + timedelta(days=i)
            if day_dt.day in days_set:
                try:
                    cand = day_dt.replace(hour=target_hour, minute=target_minute, second=0, microsecond=0)
                    if cand > local_from + timedelta(seconds=60):
                        return cand.astimezone(timezone.utc)
                except ValueError:
                    continue

    return None

def get_projected_runs(
    recurring_type: str,
    recurring_time: str,
    recurring_days: Any,
    start_dt: datetime,
    end_dt: datetime,
    max_count: int = 50,
    tz_offset_hours: int = 7
) -> List[datetime]:
    """Generates projected occurrences between start_dt and end_dt."""
    runs = []
    cur = start_dt
    while len(runs) < max_count:
        nxt = compute_next_run(recurring_type, recurring_time, recurring_days, cur, tz_offset_hours)
        if not nxt or nxt > end_dt:
            break
        runs.append(nxt)
        cur = nxt
    return runs
