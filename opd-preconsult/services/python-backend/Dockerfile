FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y curl tesseract-ocr tesseract-ocr-hin tesseract-ocr-tel && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ ./src/
COPY tests/ ./tests/
EXPOSE 4002
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "4002"]
