FROM runpod/base:1.0.2-cuda1300-ubuntu2404

# Install system dependencies for audio processing
RUN apt-get update && \
    apt-get install -y --no-install-recommends libsndfile1 ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Install PyTorch with CUDA 13.0 support (must use PyTorch index, not PyPI)
RUN uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu130 --no-cache-dir --system

# Install remaining Python dependencies
COPY requirements.txt /requirements.txt
RUN uv pip install --upgrade -r /requirements.txt --no-cache-dir --system

# Add handler
ADD handler.py /handler.py

# Run the handler
CMD ["python", "-u", "/handler.py"]
