FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bot.py .
COPY twitch_bot.py .
COPY youtube_reader.py .
COPY config_loader.py .
COPY run.py .

CMD ["python", "run.py"]
