FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice poppler-utils fonts-dejavu && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY engine /srv/engine
COPY engine-service /srv/engine-service
RUN pip install -e /srv/engine && pip install -r /srv/engine-service/requirements.txt
WORKDIR /srv/engine-service
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
