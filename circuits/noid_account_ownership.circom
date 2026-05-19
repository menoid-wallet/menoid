pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

template NoirAccountOwnership(){
    // commitment
    signal input commitment; // public
    signal input randomness; // private

    // call commitment
    signal input callCommitment; // public
    signal input nonce; // public

    // execution details 
    signal input target; 
    signal input value; 
    signal input dataHash;


    // ownership
    signal input sk; // private
    signal input pk; // private
    
    // pk = poseidon(sk)
    component ownershipHasher = Poseidon(2);
    ownershipHasher.inputs[0] <== 3; // <--- domain seperator
    ownershipHasher.inputs[1] <== sk;
    pk === ownershipHasher.out; // zk publickey ownership constraint
    
    // Cmx = Poseidon(4, zkPubKey, r)
    component commitmentHasher = Poseidon(3);
    commitmentHasher.inputs[0] <== 4; //<- domain seperator
    commitmentHasher.inputs[1] <== pk;
    commitmentHasher.inputs[2] <== randomness;

    commitmentHasher.out === commitment;

    signal actionHash;
    component actionHasher = Poseidon(3);

    actionHasher.inputs[0] <== target;
    actionHasher.inputs[1] <== value;
    actionHasher.inputs[2] <== dataHash;
    actionHash <== actionHasher.out;

    // callCmx = Poseidon(cmx, nonce);
    component callCmxHasher = Poseidon(3);
    callCmxHasher.inputs[0] <== commitment;
    callCmxHasher.inputs[1] <== nonce;
    callCmxHasher.inputs[2] <== actionHash;

    callCmxHasher.out === callCommitment;
}

component main {public [
commitment,
callCommitment,
nonce,
target,
value,
dataHash
]} = NoirAccountOwnership();