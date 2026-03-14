# Capability STDIN Specification

## Purpose
Defines the behavior for capability stdin.

## Requirements

### Requirement: Capability STDIN behavior
The system SHALL support main stdin capability.

#### Scenario: Capability STDIN is requested
- GIVEN capability stdin is available
- WHEN a user requests capability stdin
- THEN the system fulfills main stdin capability
