packer {
  required_plugins {
    digitalocean = {
      source  = "github.com/digitalocean/digitalocean"
      version = "= 1.4.1"
    }
  }
}

variable "api_token" {
  type      = string
  sensitive = true
}

variable "application_image" {
  type = string

  validation {
    condition     = can(regex("^ghcr\\.io/philosophimoonbeam/wiki@sha256:[0-9a-f]{64}$", var.application_image))
    error_message = "application_image must be the canonical application repository pinned to a sha256 digest."
  }
}

variable "release_version" {
  type = string

  validation {
    condition     = length(trimspace(var.release_version)) > 0
    error_message = "release_version must not be empty."
  }
}

variable "source_revision" {
  type = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.source_revision))
    error_message = "source_revision must be a full lowercase Git SHA."
  }
}

variable "base_image_id" {
  type = string

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.base_image_id))
    error_message = "base_image_id must be a resolved numeric DigitalOcean image ID."
  }
}

variable "apt_snapshot" {
  type = string

  validation {
    condition     = can(regex("^[0-9]{8}T[0-9]{6}Z$", var.apt_snapshot))
    error_message = "apt_snapshot must be an Ubuntu snapshot timestamp in YYYYMMDDTHHMMSSZ format."
  }
}

variable "postgres_image" {
  type = string

  validation {
    condition     = can(regex("^docker\\.io/library/postgres@sha256:[0-9a-f]{64}$", var.postgres_image))
    error_message = "postgres_image must be the canonical PostgreSQL repository pinned to a sha256 digest."
  }
}

variable "docker_package_manifest_sha256" {
  type = string

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.docker_package_manifest_sha256))
    error_message = "docker_package_manifest_sha256 must be a sha256 digest."
  }
}

locals {
  application_name = "tsFranki"
  image_name       = "tsfranki-${formatdate("YYYYMMDDhhmmss", timestamp())}"
}

source "digitalocean" "wiki" {
  api_token     = var.api_token
  image         = var.base_image_id
  region        = "tor1"
  size          = "s-1vcpu-1gb"
  snapshot_name = local.image_name
  ssh_username  = "root"
}

build {
  sources = ["source.digitalocean.wiki"]

  provisioner "shell" {
    inline = ["cloud-init status --wait"]
  }

  provisioner "file" {
    source      = "scripts/001-onboot.sh"
    destination = "/var/lib/cloud/scripts/per-instance/001-onboot.sh"
  }

  provisioner "file" {
    source      = "scripts/099-one-click"
    destination = "/etc/update-motd.d/099-one-click"
  }

  provisioner "shell" {
    inline = [
      "chmod +x /var/lib/cloud/scripts/per-instance/001-onboot.sh",
      "chmod +x /etc/update-motd.d/099-one-click"
    ]
  }

  provisioner "shell" {
    inline = ["mkdir -p /tmp/runtime-inputs"]
  }

  provisioner "file" {
    source      = "runtime-inputs/runtime-inputs.json"
    destination = "/tmp/runtime-inputs/runtime-inputs.json"
  }

  provisioner "file" {
    source      = "runtime-inputs/docker-packages.tar"
    destination = "/tmp/runtime-inputs/docker-packages.tar"
  }

  provisioner "shell" {
    environment_vars = [
      "apt_snapshot=${var.apt_snapshot}",
      "DEBIAN_FRONTEND=noninteractive",
      "LC_ALL=C",
      "LANG=en_US.UTF-8",
      "LC_CTYPE=en_US.UTF-8"
    ]
    script = "scripts/005-apt-snapshot.sh"
  }

  provisioner "shell" {
    environment_vars = [
      "application_name=${local.application_name}",
      "application_image=${var.application_image}",
      "postgres_image=${var.postgres_image}",
      "docker_package_manifest_sha256=${var.docker_package_manifest_sha256}",
      "DEBIAN_FRONTEND=noninteractive",
      "LC_ALL=C",
      "LANG=en_US.UTF-8",
      "LC_CTYPE=en_US.UTF-8"
    ]
    scripts = [
      "scripts/010-docker.sh",
      "scripts/011-ufw-docker.sh",
      "scripts/020-force-ssh-logout.sh",
      "scripts/900-cleanup.sh",
      "scripts/999-img-check.sh"
    ]
  }

  post-processor "manifest" {
    output     = "packer-manifest.json"
    strip_path = true
    custom_data = {
      application_digest = split("@", var.application_image)[1]
      apt_snapshot                   = var.apt_snapshot
      base_image_id                  = var.base_image_id
      docker_package_manifest_sha256 = var.docker_package_manifest_sha256
      application_image  = var.application_image
      postgres_digest    = split("@", var.postgres_image)[1]
      postgres_image     = var.postgres_image
      release_version    = var.release_version
      source_revision    = var.source_revision
    }
  }
}
