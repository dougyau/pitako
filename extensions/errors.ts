export class PitakoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PitakoConfigError";
  }
}
