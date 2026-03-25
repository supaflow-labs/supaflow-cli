export interface ConnectorPropertyShape {
  name: string;
  type: string;
  required: boolean;
  sensitive: boolean;
  hidden: boolean;
  defaultValue: unknown;
  enumValues: string[] | null;
  minValue: number | null;
  maxValue: number | null;
  minLength: number | null;
  maxLength: number | null;
  relatedPropertyNameAndValue: [string, ...unknown[]] | null;
}

export function shouldShowProperty(
  property: ConnectorPropertyShape,
  formValues: Record<string, unknown>,
  allProperties: ConnectorPropertyShape[],
): boolean {
  const rel = property.relatedPropertyNameAndValue;
  if (!rel || rel.length === 0) return true;

  const [parentName, ...allowedValues] = rel;
  const parentValue = formValues[parentName as string];

  // Check if parent value matches any allowed value
  const matches = allowedValues.some((v) => String(v) === String(parentValue));
  if (!matches) return false;

  // Recursively check parent visibility
  const parentProp = allProperties.find((p) => p.name === parentName);
  if (parentProp) {
    return shouldShowProperty(parentProp, formValues, allProperties);
  }

  return true;
}

export function filterVisibleFormValues(
  properties: ConnectorPropertyShape[],
  formValues: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const prop of properties) {
    const isVisible = shouldShowProperty(prop, formValues, properties);
    if (isVisible) {
      if (formValues[prop.name] !== undefined) {
        result[prop.name] = formValues[prop.name];
      }
    } else if (prop.sensitive) {
      // Explicitly null out sensitive fields that are no longer active
      result[prop.name] = null;
    }
  }

  return result;
}

export function validateProperty(
  property: ConnectorPropertyShape,
  value: string,
): string[] {
  const errors: string[] = [];

  // Required check
  if (property.required && (!value || value.trim() === '')) {
    errors.push(`"${property.name}" is required`);
    return errors; // No point checking further if empty and required
  }

  // Skip further validation on empty optional fields
  if (!value || value.trim() === '') return errors;

  // Boolean validation
  if (property.type === 'BOOLEAN') {
    const lower = value.toLowerCase();
    if (lower !== 'true' && lower !== 'false') {
      errors.push(`"${property.name}" must be "true" or "false" (got: "${value}")`);
    }
  }

  // Enum membership
  if (property.enumValues && property.enumValues.length > 0) {
    if (!property.enumValues.includes(value)) {
      errors.push(`"${property.name}" must be one of: ${property.enumValues.join(', ')} (got: "${value}")`);
    }
  }

  // Numeric range
  if (property.type === 'INTEGER' || property.type === 'NUMERIC' || property.type === 'FLOAT') {
    const num = Number(value);
    if (isNaN(num)) {
      errors.push(`"${property.name}" must be a number (got: "${value}")`);
    } else {
      if (property.minValue != null && num < property.minValue) {
        errors.push(`"${property.name}" must be >= ${property.minValue} (got: ${num})`);
      }
      if (property.maxValue != null && num > property.maxValue) {
        errors.push(`"${property.name}" must be <= ${property.maxValue} (got: ${num})`);
      }
    }
  }

  // String length
  if (property.minLength != null && value.length < property.minLength) {
    errors.push(`"${property.name}" must be at least ${property.minLength} characters`);
  }
  if (property.maxLength != null && value.length > property.maxLength) {
    errors.push(`"${property.name}" must be at most ${property.maxLength} characters`);
  }

  return errors;
}
