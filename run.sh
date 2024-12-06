#!/usr/bin/with-contenv bashio

bashio::log.info "Starting FAS HASS server..."

# Add error handling
if ! npm start; then
    bashio::log.error "Failed to start FAS HASS server"
    exit 1
fi