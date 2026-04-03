# Build
docker build -t unlimited-ai .

# Run
docker run -d \
  --name unlimited-ai \
  -p 11436:11436 \
  -e PUTER_AUTH_TOKEN=your_token_here \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/cache:/app/cache \
  --restart unless-stopped \
  unlimited-ai

# Or with docker-compose
# docker compose up -d

# View logs
docker logs -f unlimited-ai

# Stop
docker stop unlimited-ai

# Update
docker stop unlimited-ai && docker rm unlimited-ai
docker pull unlimited-ai
docker run -d --name unlimited-ai -p 11436:11436 unlimited-ai
