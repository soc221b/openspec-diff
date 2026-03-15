# auth Specification

## Purpose
This specification describes the older account recovery gate that appears before account access is granted.

## Requirements

### Requirement: The system SHALL require a legacy recovery phrase before showing the account area
The system SHALL require a legacy recovery phrase before showing the account area.

#### Scenario: A customer signs in with a legacy recovery phrase
- **WHEN** a customer submits a legacy recovery phrase during sign-in
- **THEN** the account area is shown after the legacy recovery phrase is accepted
