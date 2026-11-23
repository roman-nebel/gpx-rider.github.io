// Applies speed-coupled physical road resistance without competing with ERG.
import { recordDebugEvent } from "../ride/debug-log.mjs";
import { encodeSimulationParameters, encodeTargetResistance } from "./ftms.mjs";
import { GRADE_MIN_PERCENT, GRADE_MAX_PERCENT, SPEED_LIMITS } from "../core/tuning.mjs";

export class TrainerRoad {
  constructor(config, now = () => performance.now()) {
    this.config = { trainer_brake_grade_percent: SPEED_LIMITS.trainer_brake_grade_percent, ...config };
    this.fraction = 1;
    this.brakeStrength = 0;
    this.uphillGradePercent = 0;
    this.grade = 0;
    this.connection = null;
    this.flight = null;
    this.lastKey = null;
    this.revision = 0;
    this.now = now;
    this.lastRampAt = -Infinity;
  }

  attach(connection) {
    this.detach();
    this.connection = connection;
  }

  detach() {
    this.connection = null;
    this.flight = null;
    this.lastKey = null;
    this.minimumRejected = false;
    this.brakeStrength = 0;
    this.uphillGradePercent = 0;
    this.dirty = false;
    this.lastRampAt = -Infinity;
    this.revision++;
  }

  configure(config) {
    this.config = { trainer_brake_grade_percent: SPEED_LIMITS.trainer_brake_grade_percent, ...config };
    this.invalidate();
  }

  invalidate() {
    this.lastKey = null;
    this.revision++;
  }

  setLoad(fraction, brakeStrength = this.brakeStrength, grade = this.grade, uphillGradePercent = 0) {
    if (!Number.isFinite(fraction)) return Promise.resolve(false);
    const value = Math.min(1, Math.max(0, fraction));
    const brake = value === 0 || !Number.isFinite(brakeStrength) ? 0 : Math.min(1, Math.max(0, brakeStrength));
    const uphill = value === 0 || !Number.isFinite(uphillGradePercent) ? 0
      : Math.min(this.config.trainer_uphill_max_grade_percent, Math.max(0, uphillGradePercent));
    if (this.fraction === value && this.brakeStrength === brake && this.grade === grade && this.uphillGradePercent === uphill) return Promise.resolve(false);
    this.fraction = value;
    this.brakeStrength = brake;
    this.uphillGradePercent = uphill;
    this.revision++;
    return this.sendGrade(grade);
  }

  async sendGrade(grade, { force = false } = {}) {
    this.grade = grade;
    const connection = this.connection;
    if (!connection || connection.isErg()) return false;
    if (this.flight) {
      this.dirty = true;
      return this.flight.promise;
    }
    const fraction = this.fraction;
    const brake = this.brakeStrength;
    const partial = fraction > 0 && fraction < 1 || brake > 0 && brake < 1 || this.uphillGradePercent > 0;
    const now = this.now();
    if (partial && !force && now - this.lastRampAt < this.config.trainer_load_interval_ms) return false;
    const config = { ...this.config,
      rolling_resistance_coefficient: this.config.rolling_resistance_coefficient * fraction,
      drag_area_square_meters: this.config.drag_area_square_meters * fraction,
    };
    const minimum = fraction === 0;
    const roadGrade = grade * fraction;
    // Encode brake force as extra road resistance. Full braking cancels
    // downhill assistance, then adds the configured positive grade. The
    // route/HUD grade stays unchanged, and normal grade bounds still apply.
    const effectiveGrade = Math.min(GRADE_MAX_PERCENT, Math.max(GRADE_MIN_PERCENT,
      roadGrade + this.uphillGradePercent * fraction + brake * fraction * (Math.max(0, -roadGrade) + this.config.trainer_brake_grade_percent)));
    let bytes;
    if (connection.kind === "ftms") {
      if (connection.simulation === false) {
        connection.onError(new Error("This trainer does not support road simulation."));
        return false;
      }
      if (minimum && connection.minimumResistance !== null && !this.minimumRejected) {
        bytes = encodeTargetResistance(connection.minimumResistance);
      } else {
        bytes = encodeSimulationParameters(effectiveGrade, config);
      }
    }
    recordDebugEvent("trainer.road-target", { protocol: connection.kind, gradePercent: grade, fraction, brakeStrength: brake,
      uphillGradePercent: this.uphillGradePercent, effectiveGradePercent: effectiveGrade, minimum,
      rollingResistanceCoefficient: config.rolling_resistance_coefficient, dragAreaSquareMeters: config.drag_area_square_meters,
      windSpeedMps: config.wind_speed_mps, force, revision: this.revision });
    const key = bytes ? JSON.stringify([...bytes]) : JSON.stringify([minimum, effectiveGrade, config]);
    if (!force && key === this.lastKey) return true;
    if (partial) this.lastRampAt = now;
    const revision = this.revision;
    const ownsRoad = () => connection === this.connection && !connection.isErg();
    const valid = () => ownsRoad() && revision === this.revision;
    // Finish an already-started FE-C packet across ordinary ramp updates.
    // Disconnect, ERG, and a switch to/from minimum load still cancel it.
    const allowContinue = () => ownsRoad() && (this.fraction === 0) === minimum;
    const flight = { promise: null };
    this.flight = flight;
    this.dirty = false;
    flight.promise = (async () => {
      try {
        console.debug(`[trainer] road load ${fraction.toFixed(2)}, brake ${brake.toFixed(2)}, uphill ${this.uphillGradePercent.toFixed(1)}%, effective grade ${effectiveGrade.toFixed(1)}%`);
        const sent = bytes ? await connection.send(bytes, valid)
          : await connection.sendFec(effectiveGrade, config, minimum, valid, allowContinue);
        if (sent && connection === this.connection) {
          this.lastKey = key;
          connection.onApplied();
        }
        return Boolean(sent);
      } catch (error) {
        if (connection !== this.connection) return false;
        if (bytes?.[0] === 4 && connection.simulation !== false && /Op code not supported|Invalid parameter/.test(error.message)) {
          this.minimumRejected = true;
          this.dirty = true;
        } else {
          console.error("[trainer] road load write failed", error);
          connection.onError(error);
        }
        return false;
      } finally {
        if (this.flight === flight) {
          this.flight = null;
          if (this.dirty) {
            this.dirty = false;
            void this.sendGrade(this.grade);
          }
        }
      }
    })();
    return flight.promise;
  }
}
