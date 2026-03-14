# Delta for Capability STDIN

## MODIFIED Requirements

### Requirement: Capability STDIN behavior
The system SHALL support changed stdin capability.
(Previously: The system SHALL support main stdin capability.)

#### Scenario: Capability STDIN is updated
- GIVEN capability stdin is available
- WHEN a user requests the updated capability stdin
- THEN the system fulfills changed stdin capability
