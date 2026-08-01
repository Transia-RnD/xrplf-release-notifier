# Observatory VM — a single small GCE instance running the always-on network
# monitors (vlwatch + xrpl-crawler). Outbound-only: the monitors dial mainnet
# hubs and WS endpoints; nothing inbound except SSH. Provisioned here, then
# code is shipped + built by ../deploy.sh and run under systemd.

terraform {
  required_version = ">= 1.4"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
  }
}

provider "google" {
  project = var.project
  region  = var.region
}

resource "google_service_account" "observatory" {
  account_id   = "${var.name}-sa"
  display_name = "Observatory monitors VM"
}

# The VM writes only its heartbeat object; scope the grant to that prefix by
# using a bucket-level binding on the existing release-notifier bucket.
resource "google_storage_bucket_iam_member" "heartbeat_writer" {
  bucket = var.state_bucket
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.observatory.email}"
}

resource "google_compute_address" "external" {
  name         = "${var.name}-ext"
  address_type = "EXTERNAL"
  region       = var.region
}

resource "google_compute_instance" "observatory" {
  name         = var.name
  machine_type = var.machine_type
  zone         = var.zone
  tags         = [var.network_tag]

  boot_disk {
    initialize_params {
      image = var.image
      size  = var.boot_disk_gb
      type  = "pd-standard"
    }
  }

  network_interface {
    network = "default"
    access_config {
      nat_ip = google_compute_address.external.address
    }
  }

  service_account {
    email  = google_service_account.observatory.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    ssh-keys       = "${var.ssh_user}:${file(var.ssh_pubkey_path)}"
    startup-script = file("${path.module}/startup.sh")
  }

  allow_stopping_for_update = true
}

# Egress is open by default on GCP; we only need inbound SSH for deploys.
resource "google_compute_firewall" "ssh" {
  name    = "${var.name}-ssh"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = var.ssh_source_ranges
  target_tags   = [var.network_tag]
}
