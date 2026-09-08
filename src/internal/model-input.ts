type FunctionMember = (...args: never[]) => unknown;

type DataKey<T, Key extends keyof T> = T extends { validate(): void }
  ? string extends Key
    ? never
    : number extends Key
      ? never
      : symbol extends Key
        ? never
        : T[Key] extends FunctionMember
          ? never
          : Key
  : T[Key] extends FunctionMember
    ? never
    : Key;

/**
 * Converts a generated Alibaba SDK model class into the plain object accepted
 * by its constructor. Method members inherited from the Darabonba base model
 * are deliberately removed, including from nested request models.
 */
export type ModelInput<T> = T extends FunctionMember
  ? never
  : T extends Date
    ? Date
    : T extends readonly (infer Item)[]
      ? ModelInput<Item>[]
      : T extends object
        ? {
            [Key in keyof T as DataKey<T, Key>]: ModelInput<T[Key]>;
          }
        : T;

export type Without<T, Keys extends PropertyKey> = Omit<ModelInput<T>, Keys>;
