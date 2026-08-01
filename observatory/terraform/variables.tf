variable "project" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  type    = string
  default = "us-central1-a"
}

variable "name" {
  type    = string
  default = "xrpl-observatory"
}

variable "machine_type" {
  type    = string
  default = "e2-small" # 2 vCPU / 2GB; enough to run the monitors (build with -j2)
}

variable "image" {
  type    = string
  default = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
}

variable "boot_disk_gb" {
  type    = number
  default = 20
}

variable "network_tag" {
  type    = string
  default = "xrpl-observatory"
}

variable "state_bucket" {
  type        = string
  description = "GCS bucket for the observatory heartbeat object"
  default     = "xrplf-release-notifier"
}

variable "ssh_user" {
  type    = string
  default = "observatory"
}

variable "ssh_pubkey_path" {
  type    = string
  default = "~/.ssh/xrpl-labs.pub"
}

variable "ssh_source_ranges" {
  type        = list(string)
  description = "CIDRs allowed to SSH (tighten to your admin IPs)"
  default     = ["0.0.0.0/0"]
}
