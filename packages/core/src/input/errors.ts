/** A user-supplied value could not be parsed. `hint` shows an accepted form. */
export class InputError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'InputError';
    this.hint = hint;
  }
}
