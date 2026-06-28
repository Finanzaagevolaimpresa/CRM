export class UserFacingActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingActionError';
  }
}
