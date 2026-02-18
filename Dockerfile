FROM runpod/pytorch:1.0.2-cu1300-torch280-ubuntu2404

# Install Python dependencies (PyTorch + CUDA already in base image)
COPY requirements.txt /requirements.txt
RUN uv pip install --upgrade -r /requirements.txt --no-cache-dir --system --break-system-packages

# Add handler
ADD handler.py /handler.py

# Run the handler
CMD ["python", "-u", "/handler.py"]
