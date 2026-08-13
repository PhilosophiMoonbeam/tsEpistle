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

variable "application_version" {
  type = string
}

locals {
  application_name = "Wiki.ts Preview"
  image_name       = "wiki-ts-preview-${formatdate("YYYYMMDDhhmmss", timestamp())}"
}

source "digitalocean" "wiki" {
  api_token     = var.api_token
  image         = "ubuntu-24-04-x64"
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
    environment_vars = [
      "DEBIAN_FRONTEND=noninteractive",
      "LC_ALL=C",
      "LANG=en_US.UTF-8",
      "LC_CTYPE=en_US.UTF-8"
    ]
    inline = [
      "apt -qqy update",
      "apt -qqy -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' full-upgrade",
      "apt -qqy -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' install software-properties-common",
      "apt-get -qqy clean"
    ]
  }

  provisioner "shell" {
    environment_vars = [
      "application_name=${local.application_name}",
      "application_version=${var.application_version}",
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
}
