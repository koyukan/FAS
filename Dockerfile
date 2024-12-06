#use HASS base-nodejs as base
FROM ghcr.io/hassio-addons/base-nodejs:7b01614 

# Copy files
COPY run.sh /
RUN chmod a+x /run.sh


# Set working directory
WORKDIR /app

# Defaults to production, docker-compose overrides this to development on build and run.
ARG NODE_ENV=production
ENV NODE_ENV $NODE_ENV

# Install dependencies first, as they change less often than code.
COPY package.json package-lock.json* ./
RUN npm ci && npm cache clean --force
COPY . .

CMD [ "/run.sh" ]
