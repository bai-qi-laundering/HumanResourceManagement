FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py recruitment_excel.py ./
COPY public ./public
EXPOSE 8090
CMD ["gunicorn", "server:application", "--bind", "0.0.0.0:8090", "--workers", "1", "--threads", "4", "--timeout", "120", "--forwarded-allow-ips=", "--error-logfile", "-"]
