FROM runpod/pytorch:1.0.2-cu1300-torch280-ubuntu2404

# Install system dependencies for audio processing
RUN apt-get update && \
    apt-get install -y --no-install-recommends libsndfile1 ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt /requirements.txt
RUN uv pip install --upgrade -r /requirements.txt --no-cache-dir --system

# Add handler
ADD handler.py /handler.py

# Run the handler
CMD ["python", "-u", "/handler.py"]
