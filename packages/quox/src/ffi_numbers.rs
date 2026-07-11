use std::fmt::{Display, Formatter};
use wasm_bindgen::JsValue;

pub(super) type NumericResult<T> = Result<T, NumericArgumentError>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct NumericArgumentError {
    name: &'static str,
    expectation: &'static str,
}

impl NumericArgumentError {
    pub(super) const fn new(name: &'static str, expectation: &'static str) -> Self {
        Self { name, expectation }
    }

    pub(super) fn into_js(self) -> JsValue {
        js_sys::RangeError::new(&self.to_string()).into()
    }
}

impl Display for NumericArgumentError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "quox: {} must {}", self.name, self.expectation)
    }
}

pub(super) fn finite_f64(value: f64, name: &'static str) -> NumericResult<f64> {
    value
        .is_finite()
        .then_some(value)
        .ok_or_else(|| NumericArgumentError::new(name, "be finite"))
}

pub(super) fn nonnegative_f64(value: f64, name: &'static str) -> NumericResult<f64> {
    let value = finite_f64(value, name)?;
    (value >= 0.0)
        .then_some(value)
        .ok_or_else(|| NumericArgumentError::new(name, "be finite and nonnegative"))
}

pub(super) fn finite_f32(value: f64, name: &'static str) -> NumericResult<f32> {
    let value = finite_f64(value, name)?;
    #[allow(clippy::cast_possible_truncation)]
    let narrowed = value as f32;
    if !narrowed.is_finite() || (value != 0.0 && narrowed == 0.0) {
        return Err(NumericArgumentError::new(
            name,
            "be representable as a 32-bit float",
        ));
    }
    Ok(narrowed)
}

pub(super) fn positive_f32(value: f64, name: &'static str) -> NumericResult<f32> {
    let value = finite_f32(value, name)?;
    (value > 0.0)
        .then_some(value)
        .ok_or_else(|| NumericArgumentError::new(name, "be a positive 32-bit float"))
}

pub(super) fn uint32(value: f64, name: &'static str) -> NumericResult<u32> {
    let value = finite_f64(value, name)?;
    if value.fract() != 0.0 || value < 0.0 || value > f64::from(u32::MAX) {
        return Err(NumericArgumentError::new(
            name,
            "be an unsigned 32-bit integer",
        ));
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Ok(value as u32)
}

pub(super) fn integer_range(
    value: f64,
    minimum: u32,
    maximum: u32,
    name: &'static str,
) -> NumericResult<u32> {
    let value = uint32(value, name)?;
    (minimum..=maximum)
        .contains(&value)
        .then_some(value)
        .ok_or_else(|| NumericArgumentError::new(name, "be within the supported integer range"))
}

pub(super) fn known_mask(value: f64, known: u32, name: &'static str) -> NumericResult<u32> {
    let value = uint32(value, name)?;
    (value & !known == 0)
        .then_some(value)
        .ok_or_else(|| NumericArgumentError::new(name, "contain only known bits"))
}

pub(super) fn wasm_usize(value: f64, name: &'static str) -> NumericResult<usize> {
    let value = uint32(value, name)?;
    Ok(usize::try_from(value).expect("u32 fits usize on supported WASM and native targets"))
}

#[cfg(test)]
mod tests {
    use super::{
        finite_f32, finite_f64, integer_range, known_mask, nonnegative_f64, positive_f32, uint32,
    };

    #[test]
    fn rejects_values_that_integer_wasm_parameters_would_wrap_or_truncate() {
        assert_eq!(uint32(f64::from(u32::MAX), "value"), Ok(u32::MAX));
        for value in [f64::NAN, f64::INFINITY, -1.0, 1.5, 4_294_967_296.0] {
            assert!(uint32(value, "value").is_err());
        }
        assert_eq!(integer_range(4.0, 0, 4, "button"), Ok(4));
        assert!(integer_range(256.0, 0, 4, "button").is_err());
        assert_eq!(known_mask(f64::from(0x1f), 0x1f, "buttons"), Ok(0x1f));
        assert!(known_mask(f64::from(0x20), 0x1f, "buttons").is_err());
    }

    #[test]
    fn rejects_non_finite_and_non_representable_floating_point_values() {
        assert_eq!(finite_f64(-3.5, "delta"), Ok(-3.5));
        assert_eq!(finite_f32(12.25, "coordinate"), Ok(12.25));
        assert!(finite_f32(f64::MAX, "coordinate").is_err());
        assert!(finite_f32(f64::MIN_POSITIVE, "coordinate").is_err());
        assert!(finite_f64(f64::INFINITY, "delta").is_err());
        assert_eq!(nonnegative_f64(0.0, "timeStamp"), Ok(0.0));
        assert_eq!(nonnegative_f64(12.5, "timeStamp"), Ok(12.5));
        assert!(nonnegative_f64(-0.5, "timeStamp").is_err());
        assert!(positive_f32(0.0, "scale").is_err());
    }
}
