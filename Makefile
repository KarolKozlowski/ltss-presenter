.PHONY: build run

build:
	docker build -t ltss-presenter .

run:
	docker run -p 5000:5000 --env-file .env -v $(PWD)/config.yaml:/app/config.yaml ltss-presenter