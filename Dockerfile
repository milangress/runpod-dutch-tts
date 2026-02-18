FROM runpod/base:0.6.3-cuda11.8.0

# Set python3.11 as the default python
RUN ln -sf $(which python3.11) /usr/local/bin/python && \
    ln -sf $(which python3.11) /usr/local/bin/python3

# Install system dependencies for audio processing
RUN apt-get update && \
    apt-get install -y --no-install-recommends libsndfile1 ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Install PyTorch with CUDA 11.8 support (must use PyTorch index, not PyPI)
RUN uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu118 --no-cache-dir --system

# Install remaining Python dependencies
COPY requirements.txt /requirements.txt
RUN uv pip install --upgrade -r /requirements.txt --no-cache-dir --system

# Pre-cache the model weights at build time (~3GB) to avoid cold-start downloads
ENV HF_HOME=/models
RUN python -c "\
from transformers import AutoProcessor, DiaForConditionalGeneration; \
AutoProcessor.from_pretrained('pevers/parkiet'); \
DiaForConditionalGeneration.from_pretrained('pevers/parkiet')"

# Add handler
ADD handler.py /handler.py

# Run the handler
CMD ["python", "-u", "/handler.py"]
