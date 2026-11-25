# COURTSIDE IQ development tasks. Run `make help` for a list.
PY ?= python3
VENV := backend/.venv
VPY := $(VENV)/bin/python
PG_URL ?= postgresql+psycopg://courtside:courtside@localhost:5432/courtside

.PHONY: help install api web worker test test-backend test-frontend test-postgres build migrate snapshot load-snapshot up down

help:  ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

install:  ## Create the Python virtualenv and install backend and frontend dependencies
	$(PY) -m venv $(VENV)
	$(VPY) -m pip install -r backend/requirements.txt
	cd frontend && npm ci

api:  ## Run the API with auto-reload on http://localhost:8000
	cd backend && ../$(VPY) -m uvicorn app.main:app --reload --port 8000

web:  ## Run the web app on http://localhost:3000
	cd frontend && npm run dev

worker:  ## Run the background scheduler as a separate process
	cd backend && ENABLE_SCHEDULER=false ../$(VPY) -m app.scheduler

test: test-backend test-frontend  ## Run all tests

test-backend:  ## Backend tests on SQLite
	cd backend && ../$(VPY) -m pytest -q

test-postgres:  ## Backend tests on PostgreSQL + pgvector (set PG_URL)
	cd backend && TEST_DATABASE_URL=$(PG_URL) ../$(VPY) -m pytest -q

test-frontend:  ## Frontend type check and unit tests
	cd frontend && npm run typecheck && npm test

build:  ## Production build of the web app
	cd frontend && npm run build

migrate:  ## Apply database migrations
	cd backend && ../$(VPY) -m alembic upgrade head

snapshot:  ## Export the current database to backend/data/demo_snapshot
	cd backend && ../$(VPY) -m app.cli export-snapshot

load-snapshot:  ## Load backend/data/demo_snapshot into an empty database
	cd backend && ../$(VPY) -m app.cli load-snapshot

up:  ## Start the full stack with Docker Compose
	docker compose up --build

down:  ## Stop the Docker Compose stack
	docker compose down
