# Eclipse Mapper — a static site, so the image is a web server and nothing else.
#
# The first stage runs the data pipeline; the second keeps only its output. The
# result has no Python in it, no build tools, and nothing that runs at request
# time. Map tiles come from openfreemap.org straight to the browser, so the
# container itself needs no network access at all once it is built.
#
# The site never enters the first stage. That is deliberate: the pipeline layer
# is keyed on data-pipeline/ alone, so editing the interface leaves it cached
# and the rebuild takes seconds instead of regenerating four hundred eclipses.
# Changing anything under data-pipeline/ regenerates them, which is correct --
# that is exactly when the paths can have moved.

# ---------------------------------------------------------------- data
FROM python:3.12-slim AS pipeline

# Narrow the range to cut build time: --build-arg YEAR_MIN=2000 --build-arg YEAR_MAX=2050
ARG YEAR_MIN=1900
ARG YEAR_MAX=2100
ENV ECLIPSE_YEAR_MIN=${YEAR_MIN} ECLIPSE_YEAR_MAX=${YEAR_MAX}

WORKDIR /src
COPY data-pipeline/requirements.txt data-pipeline/requirements.txt
RUN pip install --no-cache-dir -r data-pipeline/requirements.txt

# cache/ holds the canon extract, so this stage needs no network. build.py makes
# its own output directory, so nothing from the site is needed here.
COPY data-pipeline data-pipeline

RUN python data-pipeline/build.py && test -s public/data/index.json

# ---------------------------------------------------------------- site
FROM nginx:1.27-alpine

LABEL org.opencontainers.image.title="Eclipse Mapper" \
      org.opencontainers.image.description="Solar eclipse paths 1900-2100, computed from NASA's Besselian elements" \
      org.opencontainers.image.licenses="NASA eclipse predictions by Fred Espenak, GSFC"

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# The site comes straight from the build context; only the generated data comes
# from the pipeline stage. public/data is in .dockerignore, so the first of
# these cannot smuggle in a stale local copy.
COPY public /usr/share/nginx/html
COPY --from=pipeline /src/public/data /usr/share/nginx/html/data

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q --spider http://localhost/data/index.json || exit 1
