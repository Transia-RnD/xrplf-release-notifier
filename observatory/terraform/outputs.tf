output "external_ip" {
  value       = google_compute_address.external.address
  description = "SSH here to deploy: observatory@<ip>"
}

output "service_account" {
  value = google_service_account.observatory.email
}

output "instance_name" {
  value = google_compute_instance.observatory.name
}
