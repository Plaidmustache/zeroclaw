FROM golang:1.24-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o zc-bridge

FROM alpine:3.19
WORKDIR /app
COPY --from=build /app/zc-bridge .
EXPOSE 18789
CMD ["./zc-bridge"]