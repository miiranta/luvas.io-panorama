# Panorama — luvas.io

Incremental panorama camera: each photo is detected, matched against its
neighbours, aligned and merged into a mosaic that grows in real time. All the
vision code (detector, descriptor, matching, RANSAC, bundle adjustment,
blending) is plain TypeScript running in a Web Worker — see
[frontend/README.md](frontend/README.md) for the full write-up (in Portuguese).

## Structure

```
api/            Express server that serves the compiled app (deploy stage)
frontend/       Angular 22 application
```

## Development

```sh
cd frontend
npm install --legacy-peer-deps
npm start          # dev server on http://localhost:4200
npm run build      # production build to dist/v1/browser
```

## Deploy

Same standard as the other luvas.io apps (multi-stage Docker build, Express
serving the compiled bundle):

```sh
docker compose up --build -d   # serves on port 7120
```

The camera only works in a secure context, so in production the container must
sit behind the HTTPS reverse proxy (plain `http://<ip>:7120` will load the page
but the camera stays blocked).
