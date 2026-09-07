# ---- Config ----
IMAGE_NAME := perfload-runner
DOCKER_USER := perfload
VERSION := 1.6.0

FULL_IMAGE := $(DOCKER_USER)/$(IMAGE_NAME)

# ---- Build ----
build:
	docker build -f runner/Dockerfile \
		-t $(FULL_IMAGE):$(VERSION) \
		-t $(FULL_IMAGE):latest \
		.

build-no-cache:
	docker build --no-cache -f runner/Dockerfile \
		-t $(FULL_IMAGE):$(VERSION) \
		-t $(FULL_IMAGE):latest \
		.

build-amd64:
	docker buildx build --platform linux/amd64 -f runner/Dockerfile \
		-t $(FULL_IMAGE):$(VERSION) \
		-t $(FULL_IMAGE):latest \
		.

publish-amd64:
	docker buildx build --platform linux/amd64 -f runner/Dockerfile \
		-t $(FULL_IMAGE):$(VERSION) \
		-t $(FULL_IMAGE):latest \
		--push \
		.

publish-multiarch:
	docker buildx build --platform linux/amd64,linux/arm64 -f runner/Dockerfile \
		-t $(FULL_IMAGE):$(VERSION) \
		-t $(FULL_IMAGE):latest \
		--push \
		.

# ---- Run ----
run:
	docker run -p 3000:3000 -v perfload-runs:/app/runs $(FULL_IMAGE):latest

run-version:
	docker run -p 3000:3000 -v perfload-runs:/app/runs $(FULL_IMAGE):$(VERSION)

# Foreground, with api.internal.demo mapped to the host for local demo targets
demo-run:
	docker run -p 3000:3000 \
		--add-host=api.internal.demo:host-gateway \
		-v perfload-runs:/app/runs \
		$(FULL_IMAGE):latest

# ---- Docker Hub ----
login:
	docker login

push:
	docker push $(FULL_IMAGE):$(VERSION)
	docker push $(FULL_IMAGE):latest

publish: build login push

# ---- k6 ----
k6:
	go install go.k6.io/xk6/cmd/xk6@latest
	cd runner && $$(go env GOPATH)/bin/xk6 build --with github.com/grafana/xk6-dashboard@latest --output k6

# ---- Dev (no Docker) ----
dev:
	cd runner && npm install && npm start

# ---- Clean ----
clean:
	docker image prune -f

# Removes containers and images — run data (volume) is preserved
purge:
	-docker ps -a --filter ancestor=$(FULL_IMAGE):latest --filter ancestor=$(FULL_IMAGE):$(VERSION) -q | xargs -r docker rm -f
	-docker rmi -f $(FULL_IMAGE):$(VERSION) $(FULL_IMAGE):latest

# Removes containers, images, AND all run data — cannot be undone
reset: purge
	-docker volume rm perfload-runs