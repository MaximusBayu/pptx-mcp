FROM python:3.11-slim
WORKDIR /srv/mcp-server
COPY mcp-server/requirements.txt .
RUN pip install -r requirements.txt
COPY mcp-server/ .
CMD ["python", "server.py"]
