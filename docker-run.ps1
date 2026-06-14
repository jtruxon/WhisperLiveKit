docker build -t whisperlivekit .
docker run --gpus all -p 8000:8000 whisperlivekit whisperlivekit-server --backend simulstreaming --model large-v3 --diarization