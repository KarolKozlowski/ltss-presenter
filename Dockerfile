FROM registry.np.dotnot.pl/docker.io/library/python:3.11-slim

WORKDIR /app

COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY templates /app/templates
COPY static /app/static
COPY app.py /app/

EXPOSE 5000

CMD ["python", "app.py"]
