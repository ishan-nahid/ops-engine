# Incident Runbook

## When dashboard says SMW is critical

SSH into the droplet:

```bash
ssh ishan@165.232.191.83
```

Check services:

```bash
sudo systemctl status nginx --no-pager
sudo systemctl status gunicorn-smw --no-pager
sudo systemctl status celery_smw --no-pager
sudo systemctl status celery-beat-smw --no-pager
sudo systemctl status postgresql@16-main --no-pager
sudo systemctl status redis-server --no-pager
pm2 status
```

Check recent errors:

```bash
sudo journalctl -u gunicorn-smw --since "1 hour ago" -p err --no-pager
sudo journalctl -u celery_smw --since "1 hour ago" -p err --no-pager
sudo journalctl -u nginx --since "1 hour ago" -p err --no-pager
sudo tail -n 100 /var/log/nginx/error.log
```

Check disk and memory:

```bash
df -h
free -m
uptime
```

Restart safe services if needed:

```bash
sudo systemctl restart gunicorn-smw
sudo systemctl restart celery_smw
sudo systemctl restart celery-beat-smw
pm2 restart smw-frontend
```

Reload Nginx only after config test:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## When agent is missing heartbeat

```bash
sudo systemctl status ops-engine-agent.timer --no-pager
sudo systemctl status ops-engine-agent.service --no-pager
sudo journalctl -u ops-engine-agent -n 100 --no-pager
sudo nano /usr/local/ops-engine-agent/.env
```

Run manually:

```bash
sudo /usr/local/ops-engine-agent/.venv/bin/python /usr/local/ops-engine-agent/agent.py
```

## When disk is high

```bash
sudo du -hxd1 / | sort -h
sudo du -hxd1 /var | sort -h
sudo journalctl --disk-usage
```

Vacuum old journal logs only if needed:

```bash
sudo journalctl --vacuum-time=7d
```

## When backup is stale

Check backup scripts/timers:

```bash
systemctl list-timers | grep -Ei "backup|rclone|db"
ls -lah /home/ishan/db_backups
```

Run the known backup command manually after confirming the correct path/script.

## When payment health is bad

Check SMW app logs and SSLCommerz callbacks:

```bash
sudo journalctl -u gunicorn-smw --since "2 hours ago" --no-pager | grep -Ei "ssl|payment|ipn|validation|callback"
```

## Important

Ops Engine v1 is read-only. Do not add destructive actions to the dashboard until authentication, authorization, and audit trails are complete.
