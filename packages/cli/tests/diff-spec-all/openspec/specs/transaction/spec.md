# transaction Specification

## Purpose
This specification describes how purchase activity is recorded and presented to customers and operators.

## Requirements

### Requirement: The system SHALL record each completed purchase with consistent totals, payment status, and a readable history entry
The system SHALL record each completed purchase with consistent totals, payment status, and a readable history entry.

#### Scenario: A customer reviews a completed purchase
- **WHEN** a completed purchase is opened from order history
- **THEN** the purchase details show the recorded totals and status
