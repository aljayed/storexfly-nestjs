import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsString, MaxLength } from 'class-validator';

/**
 * Create the account a new Google sign-in asked for. `agreed` is the person's
 * own "Agree & continue" - it has to be there, and true, or nothing is made.
 */
export class CompleteGoogleSignupDto {
  @ApiProperty({
    description: 'The `signup` ticket the Google callback redirected with.',
  })
  @IsString()
  @MaxLength(4096)
  ticket!: string;

  @ApiProperty({
    enum: [true],
    description:
      'The person agreed to the Terms, Privacy Policy and Return & Refund Policy.',
  })
  @Equals(true, {
    message: 'Please agree to the policies to create your account.',
  })
  agreed!: true;
}
