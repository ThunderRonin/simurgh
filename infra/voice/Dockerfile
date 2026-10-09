FROM ghcr.io/ggml-org/whisper.cpp:main@sha256:710dd21b00358b922ccd4471b61e557c225056b46fabb56cff997fe3c4cc792f
RUN apt-get update && apt-get install -y --no-install-recommends python3 espeak-ng && rm -rf /var/lib/apt/lists/*
COPY runner.py /opt/simurgh/runner.py
USER 65534:65534
ENTRYPOINT ["python3", "/opt/simurgh/runner.py"]
