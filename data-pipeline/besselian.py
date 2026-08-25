"""Besselian elements and fundamental-plane geometry for solar eclipses.

Method follows Meeus, *Elements of Solar Eclipses 1951-2200* (Willmann-Bell,
1989), chapters 8-11, and the *Explanatory Supplement to the Astronomical
Almanac*, chapter 8.

Element source: "Five Millennium Canon of Solar Eclipses: -1999 to +3000",
Fred Espenak and Jean Meeus, NASA/TP-2006-214141.
Eclipse Predictions by Fred Espenak, NASA's GSFC.
"""

from __future__ import annotations

import csv
import json
import math
import os
from dataclasses import dataclass

import numpy as np

# WGS 84 reference ellipsoid, as used for the canon's geographic coordinates.
E2 = 0.00669437999014          # first eccentricity squared
SQRT1ME2 = math.sqrt(1.0 - E2)  # 1 - f = 0.9966471893...
EARTH_RADIUS_KM = 6378.137
# Ratio of sidereal to mean solar rate; converts a UT/TDT offset into rotation.
SIDEREAL_RATE = 1.00273791

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")


# --------------------------------------------------------------------------
# Elements
# --------------------------------------------------------------------------

@dataclass
class Elements:
    """Besselian elements for one solar eclipse.

    Polynomial coefficients are ascending in ``t``, the number of hours from
    ``t0`` measured in TDT (Terrestrial Dynamical Time).
    """

    year: int
    month: int
    day: int
    jd: float            # Julian Date of greatest eclipse (TDT)
    t0: float            # reference hour (TDT) for the polynomials
    dt: float            # Delta T, seconds
    x: np.ndarray        # 4 coefficients
    y: np.ndarray        # 4
    d: np.ndarray        # 3, degrees
    mu: np.ndarray       # 3, degrees (ephemeris hour angle)
    l1: np.ndarray       # 3, penumbral radius on the fundamental plane
    l2: np.ndarray       # 3, umbral radius (negative => total)
    tanf1: float
    tanf2: float

    @property
    def key(self) -> str:
        return f"{self.year:04d}{self.month:02d}{self.day:02d}"

    def state(self, t):
        """Evaluate the elements (and their time derivatives) at TDT offset t."""
        return State(self, np.atleast_1d(np.asarray(t, dtype=float)))


def _polyval(coeffs, t):
    out = np.zeros_like(t)
    for c in reversed(coeffs):
        out = out * t + c
    return out


def _dpolyval(coeffs, t):
    """d/dt of the polynomial, per hour."""
    dc = [i * c for i, c in enumerate(coeffs)][1:]
    if not dc:
        return np.zeros_like(t)
    return _polyval(dc, t)


class State:
    """Element values at one or more instants.

    Angles are stored in radians; derivatives are per hour.
    """

    __slots__ = ("t", "x", "y", "d", "mu", "l1", "l2", "dx", "dy", "dd", "dmu",
                 "dl1", "dl2", "tanf1", "tanf2", "sind", "cosd", "rho1", "rho2",
                 "sd1", "cd1", "s12", "c12", "el")

    def __init__(self, el: Elements, t: np.ndarray):
        self.el = el
        self.t = t
        self.x = _polyval(el.x, t)
        self.y = _polyval(el.y, t)
        self.dx = _dpolyval(el.x, t)
        self.dy = _dpolyval(el.y, t)
        self.d = np.radians(_polyval(el.d, t))
        self.dd = np.radians(_dpolyval(el.d, t))
        self.mu = np.radians(_polyval(el.mu, t))
        self.dmu = np.radians(_dpolyval(el.mu, t))
        self.l1 = _polyval(el.l1, t)
        self.l2 = _polyval(el.l2, t)
        self.dl1 = _dpolyval(el.l1, t)
        self.dl2 = _dpolyval(el.l2, t)
        self.tanf1 = el.tanf1
        self.tanf2 = el.tanf2

        self.sind = np.sin(self.d)
        self.cosd = np.cos(self.d)
        # Auxiliary quantities that flatten the ellipsoid onto a unit sphere.
        self.rho1 = np.sqrt(1.0 - E2 * self.cosd ** 2)
        self.rho2 = np.sqrt(1.0 - E2 * self.sind ** 2)
        self.sd1 = self.sind / self.rho1
        self.cd1 = SQRT1ME2 * self.cosd / self.rho1
        self.s12 = E2 * self.sind * self.cosd / (self.rho1 * self.rho2)
        self.c12 = SQRT1ME2 / (self.rho1 * self.rho2)

    # -- geometry -------------------------------------------------------

    def surface(self, xi, eta, tol=1e-9):
        """Project a fundamental-plane point onto the near face of the ellipsoid.

        Returns ``(lat_deg, lon_deg, zeta)`` where ``zeta`` is the height of the
        surface point above the fundamental plane in equatorial radii.  Points
        whose (xi, eta) fall outside the Earth's disc yield NaN.
        """
        eta1 = eta / self.rho1
        z1sq = 1.0 - xi * xi - eta1 * eta1
        with np.errstate(invalid="ignore"):
            zeta1 = np.where(z1sq >= -tol, np.sqrt(np.clip(z1sq, 0.0, None)), np.nan)

        sin_u = eta1 * self.cd1 + zeta1 * self.sd1
        cos_u_cos_theta = zeta1 * self.cd1 - eta1 * self.sd1
        cos_u = np.sqrt(np.clip(1.0 - sin_u * sin_u, 0.0, 1.0))

        theta = np.degrees(np.arctan2(xi, cos_u_cos_theta))
        lon = theta - np.degrees(self.mu) + self.dt_rotation()
        lon = (lon + 180.0) % 360.0 - 180.0
        lat = np.degrees(np.arctan2(sin_u, SQRT1ME2 * cos_u))

        zeta = self.rho2 * (zeta1 * self.c12 - eta1 * self.s12)
        return lat, lon, zeta

    def dt_rotation(self) -> float:
        """Degrees of Earth rotation corresponding to Delta T.

        The elements' ``mu`` is an *ephemeris* hour angle, reckoned from the
        ephemeris meridian rather than from Greenwich.  Geographic longitude is
        therefore ``theta - mu + this``.  The sign is not a matter of taste: the
        other one puts the 2024 path 0.6 deg out of place.
        """
        return SIDEREAL_RATE * self.el.dt * 15.0 / 3600.0


    def observer(self, lat_deg, lon_deg):
        """Fundamental-plane coordinates of a ground observer at each instant.

        The inverse of :meth:`surface`.  ``lat``/``lon`` broadcast against the
        state's time axis.
        """
        phi = np.radians(lat_deg)
        u = np.arctan2(SQRT1ME2 * np.sin(phi), np.cos(phi))   # safe at the poles
        s_u, c_u = SQRT1ME2 * np.sin(u), np.cos(u)
        theta = np.radians(lon_deg + np.degrees(self.mu) - self.dt_rotation())
        xi = c_u * np.sin(theta)
        eta = s_u * self.cosd - c_u * np.cos(theta) * self.sind
        zeta = s_u * self.sind + c_u * np.cos(theta) * self.cosd
        return xi, eta, zeta

    def central_line(self):
        """Geographic position of the shadow axis (NaN where the axis misses Earth)."""
        lat, lon, zeta = self.surface(self.x, self.y)
        return lat, lon, zeta

    def shadow_radii(self, zeta):
        """Umbral/penumbral radii of the cones at height ``zeta``."""
        l1p = self.l1 - zeta * self.tanf1
        l2p = self.l2 - zeta * self.tanf2
        return l1p, l2p

    def relative_motion(self, xi, eta, zeta):
        """Shadow-axis velocity relative to a ground point, in the fundamental plane.

        A point fixed on the rotating ellipsoid moves as
        ``xi' = mu'(zeta cos d - eta sin d)`` and ``eta' = mu' xi sin d - d' zeta``
        (differentiate the standard xi/eta/zeta relations with theta = mu + lambda).
        """
        a = self.dx - self.dmu * (zeta * self.cosd - eta * self.sind)
        b = self.dy - self.dmu * xi * self.sind + self.dd * zeta
        return a, b


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------

_TYPE_NAMES = {"T": "total", "A": "annular", "H": "hybrid", "P": "partial"}


def load_catalog(path=None):
    """Load every eclipse in the canon from the bulk Besselian-element extract.

    Returns a list of ``(Elements, extra)`` where ``extra`` is the canon's
    published summary row (type, magnitude, gamma, greatest-eclipse position...).
    """
    path = path or os.path.join(CACHE, "extra.json")
    with open(path) as fh:
        rows = json.load(fh)["data"]

    out = []
    for r in rows:
        el = Elements(
            year=r["year"], month=r["month"], day=r["day"],
            jd=r["jd"],
            t0=float(str(r["t0"]).replace(" TDT", "")),
            dt=float(r["deltat"]),
            x=np.array([r["x1"], r["x2"], r["x3"], r["x4"]], dtype=float),
            y=np.array([r["y1"], r["y2"], r["y3"], r["y4"]], dtype=float),
            d=np.array([r["d1"], r["d2"], r["d3"]], dtype=float),
            mu=np.array([r["mu1"], r["mu2"], r["mu3"]], dtype=float),
            l1=np.array([r["l11"], r["l12"], r["l13"]], dtype=float),
            l2=np.array([r["l21"], r["l22"], r["l23"]], dtype=float),
            tanf1=float(r["tanf1"]),
            tanf2=float(r["tanf2"]),
        )
        out.append((el, r))
    return out


def eclipse_kind(extra) -> str:
    """Normalised eclipse type: total / annular / hybrid / partial."""
    return _TYPE_NAMES.get(str(extra["eclipse_type"])[0].upper(), "partial")
